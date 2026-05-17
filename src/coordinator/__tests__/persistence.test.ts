import { describe, it, expect, vi } from 'vitest';
import { DebouncedSaver } from '../persistence';

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
