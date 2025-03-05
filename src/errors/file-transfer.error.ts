export class FileTransferError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileTransferError';
    }
}
