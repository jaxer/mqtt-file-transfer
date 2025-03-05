import * as mqtt from 'mqtt';
import { MqttFileReceiver } from '../src/mqtt-file.receiver';
import { MqttFileSender } from '../src/mqtt-file.sender';
import { MqttjsFacade } from '../src/mqttjs.facade';

describe('e2e', () => {
    it('should use real MQTT Broker', async () => {
        const receiverClient = mqtt.connect('mqtt://localhost:1883');
        const senderClient = mqtt.connect('mqtt://localhost:1883');

        const receiver = new MqttFileReceiver(
            './received-files',
            new MqttjsFacade(receiverClient),
        );

        await receiver.addSubscriptions();

        const sender = new MqttFileSender(senderClient);
        const fileUrl = await sender.transferFile('big-files/random_100MB.bin');

        expect(fileUrl).toMatch(/^file:\/\/.*$/);

        receiverClient.end();
        senderClient.end();
    });
});
