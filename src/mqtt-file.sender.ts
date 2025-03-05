import * as assert from 'assert';
import { queue } from 'async';
import {
    ClassConstructor,
    instanceToPlain,
    plainToInstance,
} from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { MqttClient } from 'mqtt';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { inspect } from 'node:util';
import { ChunkBitmap } from './chunk.bitmap';
import {
    AddFileDto,
    AddFileResponseDto,
    AddFileResponseStatus,
    FileTransferAbortDto,
    FileTransferAckDto,
    FileTransferEofDto,
    FileTransferProgressDto,
} from './file-transfer.dto';
import {
    FileTransferAborted,
    FileTransferServerError,
    FileTransferTimeout,
} from './file-transfer.errors';
import { FileTransferTopics, StreamTopicType } from './file-transfer.topics';
import { EmptyLogger } from './logger/empty.logger';
import { LoggerInterface } from './logger/logger.interface';

enum FileTransferEvent {
    created = 'created',
    ack = 'ack',
    error = 'error',
    chunk = 'chunk',
}

class FileTransfer extends EventEmitter<{
    [FileTransferEvent.created]: [];
    [FileTransferEvent.ack]: [FileTransferAckDto];
    [FileTransferEvent.error]: [error: unknown];
    [FileTransferEvent.chunk]: [];
}> {
    public readonly requestToken = randomUUID();
    public streamId?: string;
    public ack?: FileTransferAckDto;
    public abortReason?: string;
    public chunkSize?: number;
    public checksum?: string;

    constructor(
        public readonly fileName: string,
        public readonly fileSize: number,
        public readonly startedAt: number,
    ) {
        super({ captureRejections: true });
    }
}

export class MqttFileSender {
    private readonly _streamCreateTimeout = 5000;
    private readonly _streamAckTimeout = 60000;
    private readonly _skipEvery10thChunkForTests = false;

    private readonly _promiseQueue = queue(
        (task: () => Promise<void>, callback) => {
            task().then(() => callback(), callback);
        },
    );
    private readonly _fileTransfers: FileTransfer[] = [];

    private readonly _onMqttMessageWrapperBound =
        this._onMqttMessageWrapper.bind(this);

    constructor(
        private readonly _mqttClient: MqttClient,
        private readonly _logger: LoggerInterface = new EmptyLogger(),
    ) {}

    public async transferFile(fileName: string): Promise<string> {
        this._logger.info(`Sending file: ${fileName}`);

        this._mqttClient.on('message', this._onMqttMessageWrapperBound);

        try {
            const fileTransfer = new FileTransfer(
                fileName,
                await this._getFileSize(fileName),
                new Date().getTime(),
            );
            this._fileTransfers.push(fileTransfer);

            try {
                await this._requestNewStream(fileTransfer);
                await this._subscribeToAddFileResponse();
                try {
                    await Promise.race([
                        once(fileTransfer, FileTransferEvent.created),
                        this._createTimeout(
                            this._streamCreateTimeout,
                            'Timeout waiting for stream creation.',
                        ),
                    ]);
                } finally {
                    await this._unsubscribeFromAddFileResponse();
                }

                const streamId = fileTransfer.streamId;
                assert.ok(
                    streamId,
                    'StreamId not set after streamCreated event.',
                );

                await this._subscribeToStream(streamId);
                try {
                    this._logger.info(
                        `Stream created: ${streamId}, sending file chunks`,
                    );

                    const ackPromise = once(
                        fileTransfer,
                        FileTransferEvent.ack,
                    );
                    await this._sendFileChunks(fileTransfer);

                    this._logger.info(
                        `Waiting for re-transfers and acknowledgement...`,
                    );
                    while (
                        (await Promise.race([
                            ackPromise.then(() => 'ack' as const),
                            once(fileTransfer, FileTransferEvent.chunk).then(
                                () => 'chunk' as const,
                            ),
                            this._createTimeout(
                                this._streamAckTimeout,
                                'Timeout waiting for stream acknowledgement.',
                            ),
                        ])) !== 'ack'
                    ) {
                        // each re-transfer chunk resets the timeout
                    }

                    assert.ok(fileTransfer.ack, 'Ack not set after ack event.');

                    this._logger.info(
                        `File transfer completed: ${fileName} (streamId: ${streamId}). File url: ${fileTransfer.ack.fileUrl}`,
                    );

                    return fileTransfer.ack.fileUrl;
                } catch (error: unknown) {
                    if (!(error instanceof FileTransferAborted)) {
                        await this._abortTransfer(
                            streamId,
                            String((error as Error)?.message || error),
                        );
                    }
                    throw error;
                } finally {
                    await this._unsubscribeFromStream(streamId);
                }
            } finally {
                this._fileTransfers.splice(
                    this._fileTransfers.indexOf(fileTransfer),
                    1,
                );
            }
        } finally {
            this._mqttClient.off('message', this._onMqttMessageWrapperBound);
        }
    }

    private async _publishChecksum(fileTransfer: FileTransfer) {
        assert.ok(this._mqttClient, 'MQTT client not initialized.');
        assert.ok(fileTransfer.streamId, 'StreamId not set.');
        assert.ok(fileTransfer.checksum, 'Checksum not set.');

        const topic = FileTransferTopics.getStreamTopic(
            fileTransfer.streamId,
            StreamTopicType.eof,
        );
        this._logger.info(
            `Transfer finished, publishing checksum ${fileTransfer.checksum} to topic: ${topic}`,
        );

        const dto = new FileTransferEofDto();
        dto.checksum = fileTransfer.checksum;

        await this._publishDto(topic, dto);
    }

    private async _publishChunk(
        fileTransfer: FileTransfer,
        offset: number,
        chunk: Buffer,
    ) {
        assert.ok(this._mqttClient, 'MQTT client not initialized.');
        assert.ok(fileTransfer.streamId, 'StreamId not set.');

        const chunkChecksum = createHash('sha256').update(chunk).digest('hex');
        const chunkTopic = FileTransferTopics.getChunkTopic(
            fileTransfer.streamId,
            offset,
            chunkChecksum,
        );

        await this._mqttClient.publishAsync(chunkTopic, chunk, {
            qos: FileTransferTopics.chunkQos,
        });

        fileTransfer.emit(FileTransferEvent.chunk);

        this._logger.debug(`Published ${chunkTopic} (${chunk.length}b)`);
    }

    private async _sendFileChunks(fileTransfer: FileTransfer) {
        assert.ok(fileTransfer.streamId, 'StreamId not set.');
        assert.ok(fileTransfer.chunkSize, 'ChunkSize not set.');

        const hash = createHash('sha256');
        const fileStream = createReadStream(fileTransfer.fileName, {
            highWaterMark: fileTransfer.chunkSize,
        });
        let offset = 0;
        for await (const chunk of fileStream) {
            if (fileTransfer.abortReason !== undefined) {
                throw new FileTransferAborted(fileTransfer.abortReason);
            }
            if (
                this._skipEvery10thChunkForTests &&
                offset % (chunk.length * 10) === 0
            ) {
                this._logger.warn(
                    `Skipping chunk at offset ${offset} to test re-transfers. ` +
                        `Chunk checksum: ${createHash('sha256').update(chunk).digest('hex')}`,
                );
            } else {
                await this._publishChunk(fileTransfer, offset, chunk);
            }
            hash.update(chunk);
            offset += chunk.length;
        }
        fileTransfer.checksum = hash.digest('hex');
        await this._publishChecksum(fileTransfer);
    }

    private async _processRetransfer(fileTransfer: FileTransfer, raw: Buffer) {
        assert.ok(
            fileTransfer.chunkSize,
            'ChunkSize not set at time of re-transfer. Re-transfer arrived before addFileResponse?',
        );
        assert.ok(
            fileTransfer.streamId,
            'ChunkSize not set at time of re-transfer. Re-transfer arrived before addFileResponse?',
        );
        const chunkBitmap = new ChunkBitmap(
            fileTransfer.fileSize,
            fileTransfer.chunkSize,
            raw,
        );

        const fileHandle = await open(fileTransfer.fileName, 'r+');
        const buffer = Buffer.alloc(fileTransfer.chunkSize);
        try {
            for (const offset of chunkBitmap.getMissingChunks()) {
                if (fileTransfer.abortReason !== undefined) {
                    throw new FileTransferAborted(fileTransfer.abortReason);
                }
                const readResult = await fileHandle.read(
                    buffer,
                    0,
                    fileTransfer.chunkSize,
                    offset,
                );
                await this._publishChunk(
                    fileTransfer,
                    offset,
                    buffer.subarray(0, readResult.bytesRead),
                );
            }
        } finally {
            await fileHandle.close();
        }
        await this._publishChecksum(fileTransfer);
    }

    private async _abortTransfer(streamId: string, reason: string) {
        assert.ok(this._mqttClient, 'MQTT client not initialized.');

        this._logger.warn(
            `Aborting transfer, streamId: ${streamId}. Reason: ${reason}`,
        );

        const dto = new FileTransferAbortDto();
        dto.reason = reason;

        await this._publishDto(
            FileTransferTopics.getStreamTopic(streamId, StreamTopicType.abort),
            dto,
        );
    }

    private async _publishDto(topic: string, dto: object) {
        assert.ok(this._mqttClient, 'MQTT client not initialized.');
        await validateOrReject(dto);
        await this._mqttClient.publishAsync(
            topic,
            JSON.stringify(instanceToPlain(dto)),
            {
                qos: 1,
            },
        );
    }

    private async _createTimeout(
        timeout: number,
        message: string,
    ): Promise<never> {
        await setTimeout(timeout, undefined, {
            ref: false,
        });
        throw new FileTransferTimeout(message);
    }

    private async _requestNewStream(fileTransfer: FileTransfer) {
        assert.ok(this._mqttClient, 'MQTT client not initialized.');
        const dto = new AddFileDto();
        dto.requestToken = fileTransfer.requestToken;
        dto.fileSize = fileTransfer.fileSize;
        await this._publishDto(FileTransferTopics.getAddFileTopic(), dto);
    }

    private async _onMqttMessage(topic: string, raw: Buffer) {
        if (topic === FileTransferTopics.getAddFileResponseTopic()) {
            const dto = await this._parseAndValidateDto(
                raw,
                AddFileResponseDto,
            );
            this._logger.debug(`Received ${topic}: ${inspect(dto)}`);

            const fileTransfer = this._fileTransfers.find(
                (fileTransfer) =>
                    fileTransfer.requestToken === dto.requestToken,
            );

            if (fileTransfer) {
                if (dto.status === AddFileResponseStatus.OK) {
                    fileTransfer.streamId = dto.streamId;
                    fileTransfer.chunkSize = dto.chunkSize;
                    fileTransfer.emit(FileTransferEvent.created);
                } else {
                    fileTransfer.emit(
                        FileTransferEvent.error,
                        new FileTransferServerError(
                            dto.error ?? 'Unknown Error',
                        ),
                    );
                }
            }
        } else {
            for (const fileTransfer of this._fileTransfers) {
                const streamId = fileTransfer.streamId;
                if (!streamId) {
                    continue;
                }

                const isMatch = (type: StreamTopicType) =>
                    topic === FileTransferTopics.getStreamTopic(streamId, type);

                if (isMatch(StreamTopicType.ack)) {
                    const dto = await this._parseAndValidateDto(
                        raw,
                        FileTransferAckDto,
                    );
                    this._logger.info(`Received ${topic}: ${inspect(dto)}`);
                    fileTransfer.ack = dto;
                    fileTransfer.emit(FileTransferEvent.ack, dto);
                } else if (isMatch(StreamTopicType.abort)) {
                    const dto = await this._parseAndValidateDto(
                        raw,
                        FileTransferAbortDto,
                    );
                    this._logger.warn(`Received ${topic}: ${inspect(dto)}`);
                    fileTransfer.abortReason = dto.reason;
                    fileTransfer.emit(
                        FileTransferEvent.error,
                        new FileTransferAborted(dto.reason),
                    );
                } else if (isMatch(StreamTopicType.retransfer)) {
                    this._logger.warn(`Received ${topic}`);
                    await this._processRetransfer(fileTransfer, raw);
                } else if (isMatch(StreamTopicType.progress)) {
                    const dto = await this._parseAndValidateDto(
                        raw,
                        FileTransferProgressDto,
                    );
                    const elapsed =
                        new Date().getTime() - fileTransfer.startedAt;
                    this._logger.debug(`Received ${topic}: ${inspect(dto)}.`);

                    this._logger.debug(
                        `Progress: ${((dto.bytesReceived / fileTransfer.fileSize) * 100).toFixed(2)}%`,
                    );
                    this._logger.debug(
                        `Speed: ${(((dto.bytesReceived / elapsed) * 1000) / (1024 * 1024)).toFixed(2)} MB/s`,
                    );
                }
            }
        }
    }

    private async _parseAndValidateDto<T extends object>(
        raw: Buffer,
        cls: ClassConstructor<T>,
    ): Promise<T> {
        const message = JSON.parse(raw.toString());
        const dto = plainToInstance(cls, message);
        await validateOrReject(dto);
        return dto;
    }

    private async _getFileSize(fileName: string) {
        const stats = await stat(fileName);
        return stats.size;
    }

    private async _subscribeToAddFileResponse() {
        const mqttClient = this._mqttClient;
        assert.ok(mqttClient, 'MQTT client not initialized.');

        await mqttClient.subscribeAsync(
            FileTransferTopics.getAddFileResponseTopic(),
            {
                qos: 1,
            },
        );
    }

    private async _unsubscribeFromAddFileResponse() {
        const mqttClient = this._mqttClient;
        assert.ok(mqttClient, 'MQTT client not initialized.');

        await mqttClient.unsubscribeAsync(
            FileTransferTopics.getAddFileResponseTopic(),
        );
    }

    private async _subscribeToStream(streamId: string) {
        const mqttClient = this._mqttClient;
        assert.ok(mqttClient, 'MQTT client not initialized.');

        await mqttClient.subscribeAsync(
            Object.keys(FileTransferTopics.getSenderStreamTopics(streamId)),
            {
                qos: 1,
            },
        );
    }

    private async _unsubscribeFromStream(streamId: string) {
        const mqttClient = this._mqttClient;
        assert.ok(mqttClient, 'MQTT client not initialized.');

        await mqttClient.unsubscribeAsync(
            Object.keys(FileTransferTopics.getSenderStreamTopics(streamId)),
        );
    }

    private async _onMqttMessageWrapper(topic: string, message: Buffer) {
        void this._promiseQueue.push(async () => {
            try {
                await this._onMqttMessage(topic, message);
            } catch (error: unknown) {
                this._logger.error(error);
            }
        });
    }
}
