export enum StreamTopicType {
    abort = 'abort',
    eof = 'eof',
    chunk = 'chunk',
    ack = 'ack',
    retransfer = 'retransfer',
    progress = 'progress',
}

export class FileTransferTopics {
    public static chunkQos = 0 as const;

    public static getAddFileTopic(): string {
        return 'storage/addFile';
    }

    public static getAddFileResponseTopic(): string {
        return 'storage/addFile/response';
    }

    public static getStreamTopic(
        streamId: string,
        type: StreamTopicType,
    ): string {
        return `storage/stream/${streamId}/${type}`;
    }

    public static getChunkTopic(
        streamId: string,
        offset: number,
        checksum: string,
    ): string {
        return `storage/stream/${streamId}/${StreamTopicType.chunk}/${offset}/${checksum}`;
    }

    public static getChunkFilter(streamId: string): string {
        return `storage/stream/${streamId}/chunk/#`;
    }

    public static getReceiverStreamTopics(
        streamId: string,
    ): Record<string, 0 | 1> {
        return {
            [FileTransferTopics.getStreamTopic(streamId, StreamTopicType.eof)]:
                1,
            [FileTransferTopics.getStreamTopic(
                streamId,
                StreamTopicType.abort,
            )]: 1,
            [FileTransferTopics.getChunkFilter(streamId)]: this.chunkQos,
        };
    }

    public static getSenderStreamTopics(
        streamId: string,
    ): Record<string, 0 | 1> {
        return {
            [FileTransferTopics.getStreamTopic(streamId, StreamTopicType.ack)]:
                1,
            [FileTransferTopics.getStreamTopic(
                streamId,
                StreamTopicType.abort,
            )]: 1,
            [FileTransferTopics.getStreamTopic(streamId, StreamTopicType.eof)]:
                1,
            [FileTransferTopics.getStreamTopic(
                streamId,
                StreamTopicType.retransfer,
            )]: 1,
            [FileTransferTopics.getStreamTopic(
                streamId,
                StreamTopicType.progress,
            )]: 1,
        };
    }
}
