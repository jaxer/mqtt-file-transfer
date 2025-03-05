export class ChunkBitmap {
    private readonly _bitmap: Uint8Array;
    private readonly _totalChunks: number;
    private _receivedChunks = 0;

    constructor(
        fileSize: number,
        private readonly _chunkSize: number,
        bitmap?: Uint8Array,
    ) {
        this._totalChunks = Math.ceil(fileSize / this._chunkSize);
        this._bitmap =
            bitmap ?? new Uint8Array(Math.ceil(this._totalChunks / 8));
    }

    public trackChunk(offset: number): boolean {
        const chunkIndex = Math.floor(offset / this._chunkSize);
        const byteIndex = Math.floor(chunkIndex / 8);
        const bitPosition = chunkIndex % 8;
        const mask = 1 << bitPosition;

        if ((this._bitmap[byteIndex] & mask) === 0) {
            this._bitmap[byteIndex] |= mask;
            this._receivedChunks++;
        }

        return this.isComplete();
    }

    public isComplete(): boolean {
        return this._receivedChunks === this._totalChunks;
    }

    public getMissingChunksCount(): number {
        return this._totalChunks - this._receivedChunks;
    }

    public *getMissingChunks(): Iterable<number> {
        for (let byteIndex = 0; byteIndex < this._bitmap.length; byteIndex++) {
            const byte = this._bitmap[byteIndex];
            if (byte === 0xff) {
                continue;
            }
            for (let bitPosition = 0; bitPosition < 8; bitPosition++) {
                const mask = 1 << bitPosition;
                if ((byte & mask) === 0) {
                    const chunkIndex = byteIndex * 8 + bitPosition;
                    if (chunkIndex < this._totalChunks) {
                        const offset = chunkIndex * this._chunkSize;
                        yield offset;
                    }
                }
            }
        }
    }

    public getRetransferPayload(): Uint8Array {
        return this._bitmap;
    }

    public getDebugString(): string {
        return Array.from(this._bitmap)
            .map((byte) => byte.toString(2).padStart(8, '0'))
            .join(' ');
    }
}
