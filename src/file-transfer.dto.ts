import {
    IsEnum,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Min,
} from 'class-validator';

export class FileTransferAbortDto {
    @IsString()
    @IsNotEmpty()
    public reason!: string;
}

export class FileTransferEofDto {
    @IsString()
    @IsNotEmpty()
    public checksum!: string;
}

export class FileTransferAckDto {
    @IsString()
    @IsNotEmpty()
    public fileUrl!: string;
}

export class AddFileDto {
    @IsNumber()
    @IsNotEmpty()
    @Min(1)
    public fileSize!: number;

    @IsString()
    @IsNotEmpty()
    public requestToken!: string;
}

export enum AddFileResponseStatus {
    OK = 'OK',
    ERROR = 'ERROR',
}

export class AddFileResponseDto {
    @IsEnum(AddFileResponseStatus)
    @IsNotEmpty()
    public status!: AddFileResponseStatus;

    @IsString()
    @IsOptional()
    public streamId?: string;

    @IsNumber()
    @IsOptional()
    public chunkSize?: number;

    @IsString()
    @IsOptional()
    public requestToken?: string;

    @IsString()
    @IsOptional()
    public error?: string;
}

export class FileTransferProgressDto {
    @IsNumber()
    @IsNotEmpty()
    public bytesReceived!: number;
}
