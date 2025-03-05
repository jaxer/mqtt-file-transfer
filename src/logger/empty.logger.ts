import { LoggerInterface } from './logger.interface';

export class EmptyLogger implements LoggerInterface {
    public debug(): void {
        // Empty
    }

    public log(): void {
        // Empty
    }

    public info(): void {
        // Empty
    }

    public warn(): void {
        // Empty
    }

    public error(): void {
        // Empty
    }
}
