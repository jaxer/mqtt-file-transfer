import { MqttClientFacade } from "@app/mqtt-file-transfer/mqtt-client.facade";
import { mqtt } from "aws-iot-device-sdk-v2";

export class AwsDeviceSdkFacade extends MqttClientFacade {
    constructor(private readonly _client: mqtt.MqttClientConnection) {
        super();
    }

    public async subscribe(
        topic: string,
        qos: number,
        messageProcessor: (topic: string, message: ArrayBuffer) => void
    ): Promise<void> {
        await this._client.subscribe(topic, qos, messageProcessor);
    }

    public async unsubscribe(topic: string): Promise<void> {
        await this._client.unsubscribe(topic);
    }

    public async publish(
        topic: string,
        message: ArrayBuffer | string,
        qos: number,
        retain: boolean
    ): Promise<void> {
        await this._client.publish(topic, message, qos, retain);
    }
}
