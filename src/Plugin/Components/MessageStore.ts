import { Message } from "Types/types";

type Subscriber = (messages: Message[]) => void;

export class MessageStore {
	private messages: Message[] = [];
	private subscribers: Subscriber[] = [];

	addMessage(message: Message) {
		this.messages.push(message);
		this.notifySubscribers();
	}

	setMessages(messages: Message[]) {
		// Store a shallow copy so that subsequent addMessage pushes do not
		// mutate the caller's array (e.g. promptHistory[n].messages).
		this.messages = [...messages];
	}

	getMessages(): Message[] {
		return [...this.messages];
	}

	subscribe(subscriber: Subscriber) {
		this.subscribers.push(subscriber);
	}

	unsubscribe(subscriber: Subscriber) {
		this.subscribers = this.subscribers.filter((sub) => sub !== subscriber);
	}

	private notifySubscribers() {
		this.subscribers.forEach((sub) => sub(this.getMessages()));
	}
}
