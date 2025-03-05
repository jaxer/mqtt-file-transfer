import * as mqtt from 'mqtt';
import { MqttFileReceiver } from '../src/mqtt-file.receiver';
import { MqttFileSender } from '../src/mqtt-file.sender';
import { MqttjsFacade } from '../src/mqttjs.facade';

jest.setTimeout(30000); // 30 seconds

describe('e2e', () => {
    it('should use real MQTT Broker', async () => {
        const receiverClient = await mqtt.connectAsync('mqtt://localhost:1883');
        const senderClient = await mqtt.connectAsync('mqtt://localhost:1883');

        const receiver = new MqttFileReceiver(
            './received-files',
            new MqttjsFacade(receiverClient),
        );

        await receiver.addSubscriptions();

        const sender = new MqttFileSender(senderClient);
        const fileUrl = await sender.transferFile('test/random_1KB.bin');

        expect(fileUrl).toMatch(/^file:\/\/.*$/);

        await senderClient.endAsync();
        await receiverClient.endAsync();
    });
});
