import type { DestinationFactory } from './types.ts';

const registry = new Map<string, DestinationFactory>();

export function registerDestination(factory: DestinationFactory): void {
  registry.set(factory.type, factory);
}

export function getDestinationFactory(type: string): DestinationFactory | undefined {
  return registry.get(type);
}

export function listDestinationTypes(): string[] {
  return [...registry.keys()];
}

export function clearRegistry(): void {
  registry.clear();
}
