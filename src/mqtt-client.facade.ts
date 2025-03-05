export abstract class MqttClientFacade {
    abstract subscribe(
        topic: string,
        qos: 0 | 1 | 2,
        messageProcessor: (topic: string, message: ArrayBuffer) => void,
    ): Promise<void>;

    abstract unsubscribe(topic: string): Promise<void>;

    abstract publish(
        topic: string,
        message: ArrayBuffer | string,
        qos: 0 | 1 | 2,
        retain: boolean,
    ): Promise<void>;
}
