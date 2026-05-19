import { describe, it, expect, vi } from 'vitest';
import { DebouncedSaver, OpfsProjectStore } from '../persistence';
import { FakeDirectoryHandle } from '../../sw/__tests__/fakeOpfs';
import { seedProject } from '../projectModel';

describe('DebouncedSaver', () => {
  it('coalesces multiple schedules into a single save', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const saver = new DebouncedSaver(save, 50);
    saver.schedule('A');
    saver.schedule('B');
    saver.schedule('C');
    expect(save).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('C');
  });

  it('flush() runs immediately and clears any pending schedule', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const saver = new DebouncedSaver(save, 50);
    saver.schedule('A');
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('A');
    await new Promise((r) => setTimeout(r, 80));
    expect(save).toHaveBeenCalledTimes(1); // no extra fire
  });

  it('flush() on no pending data does nothing', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const saver = new DebouncedSaver(save, 50);
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('re-schedules after a successful save', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const saver = new DebouncedSaver(save, 50);
    saver.schedule('A');
    await new Promise((r) => setTimeout(r, 80));
    saver.schedule('B');
    await new Promise((r) => setTimeout(r, 80));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]![0]).toBe('A');
    expect(save.mock.calls[1]![0]).toBe('B');
  });
});

describe('OpfsProjectStore', () => {
  function makeStore(): { store: OpfsProjectStore; root: FakeDirectoryHandle } {
    const root = new FakeDirectoryHandle('root');
    const store = new OpfsProjectStore(root as unknown as FileSystemDirectoryHandle);
    return { store, root };
  }

  it('write + read round-trips a seeded project', async () => {
    const { store } = makeStore();
    const original = seedProject();
    await store.write(original);
    const loaded = await store.read();
    expect(loaded).toEqual(original);
  });

  it('read returns null when no project file exists', async () => {
    const { store } = makeStore();
    const loaded = await store.read();
    expect(loaded).toBeNull();
  });

  it('subsequent writes overwrite the previous payload', async () => {
    const { store } = makeStore();
    const a = seedProject();
    a.bpm = 100;
    await store.write(a);
    const b = seedProject();
    b.bpm = 140;
    await store.write(b);
    const loaded = await store.read();
    expect(loaded!.bpm).toBe(140);
  });

  it('read propagates non-NotFoundError exceptions', async () => {
    const { store, root } = makeStore();
    // Sabotage the root so getFileHandle throws something other than NotFoundError.
    const original = root.getFileHandle.bind(root);
    root.getFileHandle = (async () => { throw new Error('boom'); }) as typeof original;
    await expect(store.read()).rejects.toThrow(/boom/);
  });
});
