export interface LoggerInterface {
    debug(message: string): void;

    log(message: string): void;

    info(message: string): void;

    warn(message: string): void;

    error(error: unknown): void;
}
