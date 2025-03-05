import { ConsoleLogger, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { readFileSync } from 'fs';
import { prompt } from 'inquirer';
import * as mqtt from 'mqtt';
import { MqttClient } from 'mqtt';
import { IClientOptions } from 'mqtt/src/lib/client';
import { ErrorWithReasonCode } from 'mqtt/src/lib/shared';
import { Command, CommandFactory, CommandRunner, Option } from 'nest-commander';
import { inspect } from 'util';
import { MqttFileReceiver } from './mqtt-file.receiver';
import { MqttFileSender } from './mqtt-file.sender';
import { MqttjsFacade } from './mqttjs.facade';

interface MqttOptions {
    port: number;
    host: string;
    clientId: string;
    cert: string;
    key: string;
    rejectUnauthorized: boolean;
    protocol: 'mqtt' | 'mqtts';
}

abstract class MqttCommand extends CommandRunner {
    readonly #logger = new Logger(MqttCommand.name);

    @Option({
        flags: '-h, --host <host>',
        description: 'MQTT Broker host',
    })
    public parseHost(val: string): string {
        return val;
    }

    @Option({
        flags: '-p, --port <port>',
        defaultValue: 8883,
        description: 'MQTT Broker port',
    })
    public parsePort(val: string): number {
        const port = parseInt(val, 10);
        if (isNaN(port)) throw new Error('Invalid port number');
        return port;
    }

    @Option({
        flags: '-c, --clientId <clientId>',
        description: 'Client ID for MQTT connection',
    })
    public parseClientId(val: string): string {
        return val;
    }

    @Option({
        flags: '-C, --cert <cert>',
        description: 'Path to the certificate file',
    })
    public parseCertPath(val: string): string {
        return val;
    }

    @Option({
        flags: '-k, --key <key>',
        description: 'Path to the private key file',
    })
    public parseKeyPath(val: string): string {
        return val;
    }

    @Option({
        flags: '-r, --rejectUnauthorized <rejectUnauthorized>',
        defaultValue: 'false',
        description: 'Reject unauthorized certificates (true/false)',
    })
    public parseRejectUnauthorized(val: string): boolean {
        return val.toLowerCase() === 'true';
    }

    @Option({
        flags: '--protocol <protocol>',
        defaultValue: 'mqtts',
        description: 'Protocol to use (e.g., mqtt, mqtts)',
    })
    public parseProtocol(val: string): string {
        return val;
    }

    protected connect(options: MqttOptions): mqtt.MqttClient {
        const clientOptions: IClientOptions = {
            protocol: options.protocol,
            host: options.host,
            port: options.port,
        };

        if (options.clientId) {
            clientOptions.clientId = options.clientId;
        }

        if (options.cert) {
            clientOptions.cert = readFileSync(options.cert, 'utf-8');
        }

        if (options.key) {
            clientOptions.key = readFileSync(options.key, 'utf-8');
        }

        if (options.rejectUnauthorized) {
            clientOptions.rejectUnauthorized = options.rejectUnauthorized;
        }

        const mqttClient = mqtt.connect(clientOptions);

        mqttClient.on('connect', () => {
            this.#logger.log('Connected to MQTT broker.');
        });

        mqttClient.on('close', () => {
            this.#logger.log('Disconnected from MQTT broker.');
        });

        mqttClient.on('error', (error: Error | ErrorWithReasonCode) => {
            this.#logger.log('MQTT Connection error: ' + inspect(error));
        });

        mqttClient.on('disconnect', (packet) => {
            this.#logger.warn(`Connection lost, reason: ${packet.reasonCode}`);
        });

        mqttClient.on('reconnect', () => {
            this.#logger.log(`Connection re-established`);
        });

        this.#logger.log(`Attempting to connect to MQTT Broker`);

        return mqttClient;
    }
}

@Command({
    name: 'send',
    arguments: '<fileName>',
})
class SendCommand extends MqttCommand {
    readonly #logger = new Logger(SendCommand.name);

    public async run(
        args: [fileName: string],
        options: MqttOptions,
    ): Promise<void> {
        const fileName = args[0];

        const mqttClient = this.connect(options);
        const mqttFileSender = new MqttFileSender(mqttClient);

        try {
            await mqttFileSender.transferFile(fileName);
        } catch (error: unknown) {
            this.#logger.error('Transfer failed: ' + inspect(error));
        }

        await mqttClient.endAsync();
    }
}

@Command({
    name: 'receive',
    arguments: '<destinationPath>',
})
class ReceiveCommand extends MqttCommand implements OnModuleDestroy {
    private _mqttFileReceiver?: MqttFileReceiver;
    private _mqttClient?: MqttClient;

    public async run(
        args: [destinationPath: string],
        options: MqttOptions,
    ): Promise<void> {
        const destinationPath = args[0];

        this._mqttClient = this.connect(options);

        this._mqttFileReceiver = new MqttFileReceiver(
            destinationPath,
            new MqttjsFacade(this._mqttClient),
        );

        await this._mqttFileReceiver.addSubscriptions();

        await prompt([
            {
                type: 'input',
                name: 'proceed',
                message: 'Press Enter to terminate...',
                transformer: () => '',
            },
        ]);
    }

    public async onModuleDestroy(): Promise<void> {
        if (this._mqttFileReceiver) {
            await this._mqttFileReceiver.destroy();
        }

        if (this._mqttClient) {
            await this._mqttClient.endAsync();
        }
    }
}

@Module({
    providers: [SendCommand, ReceiveCommand],
})
class FileSenderModule {}

async function bootstrap() {
    const logger = new ConsoleLogger();
    logger.setLogLevels(['log', 'verbose', 'warn', 'error', 'fatal', 'debug']);

    await CommandFactory.run(FileSenderModule, {
        logger,
        serviceErrorHandler: (err) => {
            logger.error(err);
            process.exit(1);
        },
    });
}

void bootstrap();
