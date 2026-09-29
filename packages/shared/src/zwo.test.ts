import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkoutSchema } from './workout.js';
import { parseZwo, ZwoParseError } from './zwo.js';

function fixture(name: string): string {
  return readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');
}

describe('parseZwo', () => {
  it('parses simple.zwo into the full step structure', () => {
    const workout = parseZwo(fixture('simple.zwo'));
    expect(workout.name).toBe('Simple Test');
    expect(workout.description).toBe('Warmup, intervals, steady, cooldown');
    expect(workout.tags).toEqual(['ENDURANCE', 'INTERVALS']);
    expect(workout.id).toMatch(/^simple-test-[0-9a-f]{8}$/);
    expect(workout.steps).toEqual([
      { kind: 'ramp', seconds: 600, fromPctFtp: 0.4, toPctFtp: 0.75 },
      {
        kind: 'interval',
        repeats: 3,
        on: { seconds: 300, targetPctFtp: 1.05 },
        off: { seconds: 300, targetPctFtp: 0.55 },
      },
      { kind: 'steady', seconds: 600, targetPctFtp: 0.8 },
      // Cooldown maps literally (PowerLow -> fromPctFtp, PowerHigh -> toPctFtp), never swapped.
      { kind: 'ramp', seconds: 300, fromPctFtp: 0.75, toPctFtp: 0.4 },
    ]);
    expect(() => WorkoutSchema.parse(workout)).not.toThrow();
  });

  it('parses freeride.zwo with a single free step', () => {
    const workout = parseZwo(fixture('freeride.zwo'));
    expect(workout.name).toBe('Free Ride');
    expect(workout.tags).toEqual([]);
    expect(workout.steps).toEqual([{ kind: 'free', seconds: 1200 }]);
    expect(() => WorkoutSchema.parse(workout)).not.toThrow();
  });

  it('throws ZwoParseError listing unsupported tags when nothing is supported', () => {
    let error: unknown;
    try {
      parseZwo(fixture('unsupported.zwo'));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ZwoParseError);
    const message = (error as ZwoParseError).message;
    expect(message).toContain('MaxEffort');
    expect(message).toContain('SolidState');
  });

  it('skips unsupported elements silently when supported ones exist', () => {
    const xml = `<workout_file>
      <name>Mixed</name>
      <workout>
        <SteadyState Duration="60" Power="0.6"/>
        <MaxEffort Duration="30" Power="1.5"/>
      </workout>
    </workout_file>`;
    const workout = parseZwo(xml);
    expect(workout.steps).toEqual([{ kind: 'steady', seconds: 60, targetPctFtp: 0.6 }]);
  });

  it('handles repeated elements of the same type', () => {
    const xml = `<workout_file>
      <name>Repeats</name>
      <workout>
        <SteadyState Duration="60" Power="0.6"/>
        <SteadyState Duration="120" Power="0.8"/>
      </workout>
    </workout_file>`;
    const workout = parseZwo(xml);
    expect(workout.steps).toEqual([
      { kind: 'steady', seconds: 60, targetPctFtp: 0.6 },
      { kind: 'steady', seconds: 120, targetPctFtp: 0.8 },
    ]);
  });

  it('preserves document order for interleaved element types', () => {
    const workout = parseZwo(fixture('interleaved.zwo'));
    expect(workout.steps).toEqual([
      { kind: 'ramp', seconds: 300, fromPctFtp: 0.4, toPctFtp: 0.75 },
      { kind: 'steady', seconds: 300, targetPctFtp: 0.8 },
      {
        kind: 'interval',
        repeats: 2,
        on: { seconds: 60, targetPctFtp: 1.0 },
        off: { seconds: 60, targetPctFtp: 0.5 },
      },
      { kind: 'steady', seconds: 300, targetPctFtp: 0.7 },
      { kind: 'ramp', seconds: 300, fromPctFtp: 0.7, toPctFtp: 0.4 },
    ]);
    expect(() => WorkoutSchema.parse(workout)).not.toThrow();
  });

  it('rounds float-noise durations but keeps fractional power', () => {
    const workout = parseZwo(fixture('floatnoise.zwo'));
    expect(workout.steps).toEqual([
      { kind: 'ramp', seconds: 600, fromPctFtp: 0.30000001, toPctFtp: 0.75 },
      { kind: 'steady', seconds: 180, targetPctFtp: 0.89999998 },
    ]);
    expect(() => WorkoutSchema.parse(workout)).not.toThrow();
  });

  it('coerces numeric-looking tag names to strings', () => {
    const xml = `<workout_file>
      <name>Numeric Tags</name>
      <tags>
        <tag name="2024"/>
        <tag name="VO2MAX"/>
      </tags>
      <workout>
        <SteadyState Duration="60" Power="0.6"/>
      </workout>
    </workout_file>`;
    const workout = parseZwo(xml);
    expect(workout.tags).toEqual(['2024', 'VO2MAX']);
  });

  it('defaults name, description, and tags when absent', () => {
    const workout = parseZwo('<workout_file><workout><FreeRide Duration="60"/></workout></workout_file>');
    expect(workout.name).toBe('Imported Workout');
    expect(workout.description).toBe('');
    expect(workout.tags).toEqual([]);
    expect(workout.id).toMatch(/^imported-workout-[0-9a-f]{8}$/);
  });

  it('defaults an empty <name> element to Imported Workout', () => {
    const workout = parseZwo(
      '<workout_file><name></name><workout><SteadyState Duration="60" Power="0.6"/></workout></workout_file>',
    );
    expect(workout.name).toBe('Imported Workout');
    expect(workout.id).toMatch(/^imported-workout-[0-9a-f]{8}$/);
  });

  it('throws ZwoParseError for XML without a workout node', () => {
    expect(() => parseZwo('<foo><bar/></foo>')).toThrow(ZwoParseError);
  });

  it('throws ZwoParseError for garbage input', () => {
    expect(() => parseZwo('this is definitely not xml')).toThrow(ZwoParseError);
    expect(() => parseZwo('')).toThrow(ZwoParseError);
  });
});
