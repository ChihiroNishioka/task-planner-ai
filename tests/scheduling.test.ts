import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleStore } from '../src/adapters/scheduling';
import { calculateSchedule } from '../src/domain/scheduling';
import { TaskStore } from '../src/adapters/task-store';
import { PreparationStore } from '../src/adapters/preparation-store';

describe('Phase 4 deadline scheduling', () => {
  let directory: string;
  let tasks: TaskStore;
  let schedules: ScheduleStore;
  let preparations: PreparationStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'task-planner-schedule-'));
    tasks = new TaskStore(join(directory, 'tasks.sqlite'));
    schedules = new ScheduleStore(join(directory, 'tasks.sqlite'));
    preparations = new PreparationStore(join(directory, 'tasks.sqlite'), join(directory, 'artifacts'));
  });
  afterEach(() => { tasks.close(); schedules.close(); preparations.close(); rmSync(directory, { recursive: true, force: true }); });

  function task() { return tasks.create({ title: '準備する', originalInput: '準備する', aiPreparationRequired: true }, 'schedule-task'); }

  it('T-06-01 schedules the previous-day reminder, preparation, and start time', () => {
    const schedule = calculateSchedule({
      deadline: '2026-11-13T17:00:00+09:00', now: new Date('2026-11-01T00:00:00Z'),
      estimatedAiMinutes: 30, estimatedHumanMinutes: 60,
    });
    expect(schedule).toMatchObject({
      remindAt: '2026-11-12T09:00:00+09:00',
      prepareBy: '2026-11-12T08:30:00+09:00',
      reviewBy: '2026-11-12T09:00:00+09:00',
      startAt: '2026-11-12T08:00:00+09:00',
      immediate: false,
      estimatedAiMinutes: 30,
      estimatedHumanMinutes: 60,
    });
  });

  it('T-06-02 requires an offset-bearing deadline and starts deadline-free preparation immediately', () => {
    expect(() => calculateSchedule({ deadline: '2026-11-13', now: new Date('2026-11-01T00:00:00Z') })).toThrow();
    const schedule = calculateSchedule({ deadline: null, now: new Date('2026-11-01T00:00:00Z') });
    expect(schedule).toMatchObject({ remindAt: null, immediate: true, overdue: false });
  });

  it('T-06-03 makes a schedule due in the past run immediately and marks past deadlines overdue', () => {
    const before = calculateSchedule({ deadline: '2026-11-13T17:00:00+09:00', now: new Date('2026-11-12T00:00:00Z') });
    const after = calculateSchedule({ deadline: '2026-11-13T17:00:00+09:00', now: new Date('2026-11-12T00:00:01Z') });
    const overdue = calculateSchedule({ deadline: '2026-11-11T17:00:00+09:00', now: new Date('2026-11-12T00:00:01Z') });
    expect(before.immediate).toBe(true);
    expect(after.immediate).toBe(true);
    expect(overdue.overdue).toBe(true);
    const leapDay = calculateSchedule({ deadline: '2028-03-01T12:00:00+09:00', now: new Date('2028-02-20T00:00:00Z') });
    expect(leapDay.remindAt).toBe('2028-02-29T09:00:00+09:00');
  });

  it('T-06-04 returns the same Tokyo calendar values regardless of host timezone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utc = calculateSchedule({ deadline: '2026-11-13T17:00:00Z', now: new Date('2026-11-01T00:00:00Z') });
      process.env.TZ = 'Asia/Tokyo';
      const tokyo = calculateSchedule({ deadline: '2026-11-14T02:00:00+09:00', now: new Date('2026-11-01T09:00:00+09:00') });
      expect(utc.remindAt).toBe(tokyo.remindAt);
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  });

  it('T-06-05 cancels older schedule revisions when a deadline changes', () => {
    const currentTask = task();
    const first = schedules.schedule(currentTask.id, calculateSchedule({ deadline: '2026-11-13T17:00:00+09:00', now: new Date('2026-11-01T00:00:00Z') }));
    const second = schedules.schedule(currentTask.id, calculateSchedule({ deadline: '2026-11-14T17:00:00+09:00', now: new Date('2026-11-01T00:00:00Z') }));
    expect(schedules.get(first.id)?.status).toBe('CANCELLED');
    expect(second).toMatchObject({ revision: 2, status: 'SCHEDULED' });
    expect(schedules.notifications(currentTask.id)[0]?.status).toBe('CANCELLED');
  });

  it('T-06-06 preserves schedule times and revision after a store restart', () => {
    const currentTask = task();
    const schedule = schedules.schedule(currentTask.id, calculateSchedule({ deadline: '2026-11-13T17:00:00+09:00', now: new Date('2026-11-01T00:00:00Z') }));
    schedules.close();
    schedules = new ScheduleStore(join(directory, 'tasks.sqlite'));
    expect(schedules.get(schedule.id)).toEqual(schedule);
  });

  it('delivers due reminders to the in-app mock inbox once and queues due preparation', async () => {
    const currentTask = task();
    schedules.schedule(currentTask.id, calculateSchedule({ deadline: '2026-11-13T17:00:00+09:00', now: new Date('2026-11-01T00:00:00Z') }));
    const firstRun = await schedules.processDue(new Date('2026-11-12T00:00:00Z'), tasks, preparations);
    const secondRun = await schedules.processDue(new Date('2026-11-12T00:00:00Z'), tasks, preparations);
    expect(firstRun).toEqual({ started: 1, delivered: 1 });
    expect(secondRun).toEqual({ started: 0, delivered: 0 });
    expect(schedules.notifications(currentTask.id)[0]?.status).toBe('MOCK_DELIVERED');
    expect(tasks.get(currentTask.id)?.aiStatus).toBe('QUEUED');
  });
});
