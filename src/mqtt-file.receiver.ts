import * as async from 'async';
import {
    ClassConstructor,
    instanceToPlain,
    plainToInstance,
} from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { createHash, randomBytes } from 'node:crypto';
import { FileHandle, open, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { ChunkBitmap } from './chunk.bitmap';
import { FileTransferError } from './errors/file-transfer.error';
import {
    AddFileDto,
    AddFileResponseDto,
    AddFileResponseStatus,
    FileTransferAbortDto,
    FileTransferAckDto,
    FileTransferEofDto,
    FileTransferProgressDto,
} from './file-transfer.dto';
import { FileTransferTopics, StreamTopicType } from './file-transfer.topics';
import { EmptyLogger } from './logger/empty.logger';
import { LoggerInterface } from './logger/logger.interface';
import { MqttClientFacade } from './mqtt-client.facade';

const maxAllowedFileSizeInMb = 10 * 1024; // 10 GB
const chunkSizeInBytes = 64 * 1024; // 64 KB
const publishProgressEverySeconds = 1;

class ChunkStream {
    public lastProgressAt?: number;
    public abortedByReceiver?: boolean;
    public receivedBytes = 0;

    public readonly bitmap = new ChunkBitmap(
        this.addFileDto.fileSize,
        chunkSizeInBytes,
    );

    constructor(
        public readonly addFileDto: AddFileDto,
        public readonly createdAt: number,
        public readonly streamId: string,
        public readonly tempFilePath: string,
        public readonly fileHandle: FileHandle,
    ) {}

    public isTimeToPublishProgress(now: number): boolean {
        return (
            now - (this.lastProgressAt ?? 0) >
            publishProgressEverySeconds * 1000
        );
    }
}

export class MqttFileReceiver {
    private _chunkStreams = new Map<string, ChunkStream>();
    private _boundOnStreamMessage = this._onStreamMessage.bind(this);

    private _queue = async.queue((task: () => Promise<void>, callback) => {
        task().then(() => callback(), callback);
    });

    private _mqttSubscriptions: string[] = [];

    constructor(
        private readonly _workPath: string,
        private readonly _mqttClient: MqttClientFacade,
        private readonly _logger: LoggerInterface = new EmptyLogger(),
        private readonly _currentTimestampProvider: () => number = Date.now,
        private readonly _randomStringProvider: (length: number) => string = (
            length,
        ) => randomBytes(length).toString('hex').slice(0, length),
    ) {}

    public async destroy(): Promise<void> {
        await this.abortAllTransfers();

        for (const subscription of this._mqttSubscriptions) {
            await this._mqttClient?.unsubscribe(subscription);
            this._logger.log(`MQTT subscription unsubscribed: ${subscription}`);
        }

        if (this._queue.idle()) {
            this._logger.log('Queue is empty, proceeding with shutdown.');
        } else {
            this._logger.log('Waiting for queue to drain...');
            while (!this._queue.idle()) {
                await this._queue.drain();
            }
            this._logger.log('Queue drained, proceeding with shutdown.');
        }
    }

    public async cleanUpTransfers(
        cleanupTransfersOlderThanMinutes: number,
    ): Promise<void> {
        const now = this._currentTimestampProvider();

        for (const [streamId, chunkStream] of this._chunkStreams.entries()) {
            if (
                now - chunkStream.createdAt >
                cleanupTransfersOlderThanMinutes * 60 * 1000
            ) {
                try {
                    await this._closeChunkStream(chunkStream);
                    await this._publishTransferAborted(
                        chunkStream,
                        `File transfer did not complete within ${cleanupTransfersOlderThanMinutes} minutes.`,
                    );
                } catch (error) {
                    this._logger.error(
                        `Failed to abort file transfer ${streamId}: ${(error as Error)?.stack || error}`,
                    );
                }
            }
        }
    }

    public async addSubscriptions(): Promise<void> {
        const topicFilter = FileTransferTopics.getAddFileTopic();

        const mqttSubscribeRequest = await this._mqttClient.subscribe(
            topicFilter,
            1,
            this._wrapMessageProcessor(this._processAddFile.bind(this)),
        );
        this._logger.log(
            `MQTT Client subscribe call result: ${JSON.stringify(mqttSubscribeRequest)}`,
        );

        this._mqttSubscriptions.push(topicFilter);
    }

    public async abortAllTransfers(): Promise<void> {
        for (const [streamId, chunkStream] of this._chunkStreams.entries()) {
            try {
                await this._closeChunkStream(chunkStream);
                await this._publishTransferAborted(
                    chunkStream,
                    `Server shutting down`,
                );
            } catch (error) {
                this._logger.error(
                    `Failed to abort file transfer ${streamId} on module destroy: ${(error as Error)?.stack || error}`,
                );
            }
        }
    }

    private _wrapMessageProcessor(
        messageProcessor: (
            topic: string,
            message: ArrayBuffer,
        ) => Promise<void>,
    ) {
        const boundMessageProcessor = messageProcessor.bind(this);
        return (topic: string, message: ArrayBuffer) => {
            void this._queue.push(async () => {
                try {
                    return await boundMessageProcessor(topic, message);
                } catch (error) {
                    this._logger.error(
                        `Error processing message on ${topic}: ${(error as Error)?.stack || error}`,
                    );
                }
            });
        };
    }

    private async _createAndValidateDto<T extends object>(
        message: ArrayBuffer,
        cls: ClassConstructor<T>,
    ): Promise<T> {
        const instance = plainToInstance(
            cls,
            JSON.parse(new TextDecoder().decode(message)),
        );
        await validateOrReject(instance);
        return instance;
    }

    private async _onStreamMessage(topic: string, message: ArrayBuffer) {
        // topic examples:
        // storage/stream/${streamId}/abort
        // storage/stream/${streamId}/eof
        // storage/stream/${streamId}/chunk/${offset}/${checksum}

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [_, __, streamId, type, offsetAsString, checksum] =
            topic.split('/');
        const chunkStream = this._chunkStreams.get(streamId);
        if (!chunkStream) {
            return;
        }

        if (type === StreamTopicType.abort) {
            if (!chunkStream.abortedByReceiver) {
                const dto = await this._createAndValidateDto(
                    message,
                    FileTransferAbortDto,
                );
                this._logger.debug(`Received ${topic}: ${inspect(dto)}`);
                await this._processAbortBySender(chunkStream, dto);
            }
        } else if (type === StreamTopicType.eof) {
            const dto = await this._createAndValidateDto(
                message,
                FileTransferEofDto,
            );
            this._logger.debug(`Received ${topic}: ${inspect(dto)}`);
            await this._processEof(chunkStream, dto);
        } else if (type === StreamTopicType.chunk) {
            const offset = parseInt(offsetAsString);
            if (isNaN(offset)) {
                this._logger.warn(
                    `Invalid offset ${offsetAsString} for stream ${streamId}.`,
                );
                return;
            }
            const calculatedChecksum = createHash('sha256')
                .update(Buffer.from(message))
                .digest('hex');
            this._logger.debug(
                `Received ${topic}. Calculated checksum: ${calculatedChecksum}`,
            );
            if (calculatedChecksum !== checksum) {
                this._logger.warn(
                    `Checksum mismatch for stream ${streamId} at offset ${offset}. Expected: ${checksum}, Received: ${calculatedChecksum}. Skipping chunk`,
                );
            } else {
                await this._processChunk(chunkStream, offset, message);
            }

            if (
                chunkStream.isTimeToPublishProgress(
                    this._currentTimestampProvider(),
                )
            ) {
                await this._publishProgress(chunkStream);
            }
        }
    }

    private async _publishProgress(chunkStream: ChunkStream) {
        chunkStream.lastProgressAt = this._currentTimestampProvider();

        const progressDto = new FileTransferProgressDto();
        progressDto.bytesReceived = chunkStream.receivedBytes;

        await this._validateAndPublishDto(
            FileTransferTopics.getStreamTopic(
                chunkStream.streamId,
                StreamTopicType.progress,
            ),
            progressDto,
        );
    }

    private async _processChunk(
        chunkStream: ChunkStream,
        offset: number,
        message: ArrayBuffer,
    ) {
        const size = message.byteLength;
        chunkStream.receivedBytes += size;
        chunkStream.bitmap.trackChunk(offset);
        await chunkStream.fileHandle.write(
            Buffer.from(message),
            0,
            size,
            offset,
        );
    }

    private async _processAbortBySender(
        chunkStream: ChunkStream,
        abortDto: FileTransferAbortDto,
    ) {
        this._logger.warn(
            `Abort message received for stream ${chunkStream.streamId}. Reason: "${abortDto.reason}". Closing stream.`,
        );
        await this._closeChunkStream(chunkStream);
    }

    private async _processEof(
        chunkStream: ChunkStream,
        eofDto: FileTransferEofDto,
    ) {
        await chunkStream.fileHandle.sync();

        const checksum = await this._calculateChecksum(chunkStream);
        this._logger.debug(`Calculated checksum: ${checksum}`);

        if (eofDto.checksum === checksum) {
            this._logger.debug(`Checksum OK.`);
            await this._closeChunkStream(chunkStream, true);

            const ackDto = new FileTransferAckDto();
            ackDto.fileUrl = pathToFileURL(chunkStream.tempFilePath).toString();
            await this._validateAndPublishDto(
                FileTransferTopics.getStreamTopic(
                    chunkStream.streamId,
                    StreamTopicType.ack,
                ),
                ackDto,
            );
        } else {
            this._logger.warn(`Checksum NOK.`);

            if (chunkStream.bitmap.isComplete()) {
                await this._closeChunkStream(chunkStream, false);
                await this._publishTransferAborted(
                    chunkStream,
                    'All chunks received but checksum mismatch',
                );
            } else {
                this._logger.warn(
                    `Requesting retransfer for stream ${chunkStream.streamId}. Missing chunks count: ${chunkStream.bitmap.getMissingChunksCount()}`,
                );
                await this._mqttClient.publish(
                    FileTransferTopics.getStreamTopic(
                        chunkStream.streamId,
                        StreamTopicType.retransfer,
                    ),
                    chunkStream.bitmap.getRetransferPayload(),
                    1,
                    false,
                );
            }
        }
    }

    private async _processAddFile(_topic: string, message: ArrayBuffer) {
        const response = new AddFileResponseDto();

        try {
            const dto = await this._createAndValidateDto(message, AddFileDto);
            this._logger.log(`Add file received: ${inspect(dto)}`);

            response.requestToken = dto.requestToken;

            const chunkStream = await this._createChunkStream(dto);

            response.status = AddFileResponseStatus.OK;
            response.streamId = chunkStream.streamId;
            response.chunkSize = chunkSizeInBytes;

            await this._validateAndPublishDto(
                FileTransferTopics.getAddFileResponseTopic(),
                response,
            );
        } catch (error) {
            this._logger.error(
                `Error processing add file: ${(error as Error)?.stack || error}`,
            );

            response.status = AddFileResponseStatus.ERROR;
            response.error = String(
                (error as Error)?.message || error || 'Unknown error',
            );

            await this._validateAndPublishDto(
                FileTransferTopics.getAddFileResponseTopic(),
                response,
            );
        }
    }

    private async _validateAndPublishDto(topic: string, dto: object) {
        await validateOrReject(dto);

        this._logger.debug(`Publishing ${topic}: ${inspect(dto)}`);
        await this._mqttClient.publish(
            topic,
            JSON.stringify(instanceToPlain(dto)),
            1,
            false,
        );
    }

    private async _publishTransferAborted(
        chunkStream: ChunkStream,
        reason: string,
    ) {
        this._logger.warn(
            `Unsubscribing from stream ${chunkStream.streamId} and publishing abort message`,
        );

        chunkStream.abortedByReceiver = true;

        const dto = new FileTransferAbortDto();
        dto.reason = reason;
        await this._validateAndPublishDto(
            FileTransferTopics.getStreamTopic(
                chunkStream.streamId,
                StreamTopicType.abort,
            ),
            dto,
        );
    }

    private async _createChunkStream(dto: AddFileDto) {
        if (dto.fileSize > maxAllowedFileSizeInMb * 1024 * 1024) {
            throw new FileTransferError(`File too large (${dto.fileSize})`);
        }

        const { bavail, bsize } = await statfs(this._workPath);
        const freeSpace = bavail * bsize;
        if (freeSpace < dto.fileSize) {
            throw new FileTransferError(
                `Not enough free space in work path (${this._workPath}). Required: ${dto.fileSize}, Available: ${freeSpace}`,
            );
        }

        const tempFilePath = join(
            `${this._workPath}/${this._randomStringProvider(24)}`,
        );

        const fileHandle = await open(tempFilePath, 'w+');

        const chunkStream = new ChunkStream(
            dto,
            this._currentTimestampProvider(),
            this._randomStringProvider(16),
            tempFilePath,
            fileHandle,
        );

        this._logger.log(
            `Creating file for stream ${chunkStream.streamId} at ${tempFilePath}`,
        );

        this._logger.log(
            `Pre-creating file of size ${dto.fileSize} at ${tempFilePath}`,
        );
        await chunkStream.fileHandle.truncate(dto.fileSize);
        await chunkStream.fileHandle.sync();

        this._chunkStreams.set(chunkStream.streamId, chunkStream);

        for (const [topic, qos] of Object.entries(
            FileTransferTopics.getReceiverStreamTopics(chunkStream.streamId),
        )) {
            await this._mqttClient.subscribe(
                topic,
                qos,
                this._boundOnStreamMessage,
            );
        }

        return chunkStream;
    }

    private async _closeChunkStream(chunkStream: ChunkStream, success = false) {
        const streamId = chunkStream.streamId;

        this._logger.log(`Closing stream ${streamId}`);

        for (const topic of Object.keys(
            FileTransferTopics.getReceiverStreamTopics(chunkStream.streamId),
        )) {
            await this._mqttClient.unsubscribe(topic);
        }
        this._chunkStreams.delete(streamId);

        await chunkStream.fileHandle.close();

        if (!success) {
            await unlink(chunkStream.tempFilePath);
            this._logger.log(
                `Temp file for stream ${streamId} deleted and stream closed`,
            );
        } else {
            this._logger.log(`Transfer ${streamId} completed successfully.`);
        }
    }

    private async _calculateChecksum(chunkStream: ChunkStream) {
        const hash = createHash('sha256');
        for await (const buffer of chunkStream.fileHandle.createReadStream({
            autoClose: false,
            start: 0,
        })) {
            hash.update(buffer);
        }
        return hash.digest('hex');
    }
}
