import { MqttFileReceiver } from '../src/mqtt-file.receiver';
import * as mqtt from 'mqtt';
import { randomBytes } from 'node:crypto';
import { MqttjsFacade } from '../src/mqttjs.facade';
import { MqttFileSender } from '../src/mqtt-file.sender';

describe('e2e', () => {
    it('should use real MQTT Broker', async () => {
        const receiverClient = mqtt.connect('mqtt://localhost:1883');
        const senderClient = mqtt.connect('mqtt://localhost:1883');

        const receiver = new MqttFileReceiver(
            './received-files',
            new MqttjsFacade(receiverClient),
            () => Date.now(),
            (length) => randomBytes(length).toString('hex').slice(0, length),
        );

        await receiver.addSubscriptions();

        const sender = new MqttFileSender(senderClient);
        const fileUrl = await sender.transferFile('big-files/random_100MB.bin');

        expect(fileUrl).toMatch(/^file:\/\/.*$/);

        receiverClient.end();
        senderClient.end();
    });
});
