export class FileTransferAborted extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileTransferAborted';
    }
}

export class FileTransferError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileTransferError';
    }
}

export class FileTransferTimeout extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileTransferTimeout';
    }
}

export class FileTransferServerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileTransferServerError';
    }
}
