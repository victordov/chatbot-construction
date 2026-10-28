/**
 * Booking time arithmetic: opening hours in the business's timezone, the days
 * the clocks change, buffers around what is already in the diary, and the
 * slot ids that carry a choice back to the booking step.
 */

const time = require('../services/booking/time');

const ALL_WEEK = (opensAt, closesAt) =>
  [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, closed: false, opensAt, closesAt }));

const iso = date => date.toISOString();

describe('wall-clock time in a named zone', () => {
  test('09:00 in London is 09:00 UTC in winter and 08:00 UTC in summer', () => {
    expect(iso(time.zonedTime('2026-01-15', 540, 'Europe/London'))).toBe('2026-01-15T09:00:00.000Z');
    expect(iso(time.zonedTime('2026-07-15', 540, 'Europe/London'))).toBe('2026-07-15T08:00:00.000Z');
  });

  test('either side of the clocks going forward in London', () => {
    // 29 March 2026: 01:00 GMT becomes 02:00 BST.
    expect(iso(time.zonedTime('2026-03-28', 540, 'Europe/London'))).toBe('2026-03-28T09:00:00.000Z');
    expect(iso(time.zonedTime('2026-03-29', 540, 'Europe/London'))).toBe('2026-03-29T08:00:00.000Z');
  });

  test('a time inside the gap does not exist, rather than being invented an hour off', () => {
    expect(time.zonedTime('2026-03-29', 90, 'Europe/London')).toBeNull();
    expect(time.zonedTime('2026-03-08', 150, 'America/New_York')).toBeNull();
  });

  test('either side of the clocks going back, west of UTC', () => {
    // 1 November 2026: New York goes from EDT (-4) to EST (-5).
    expect(iso(time.zonedTime('2026-10-31', 540, 'America/New_York'))).toBe('2026-10-31T13:00:00.000Z');
    expect(iso(time.zonedTime('2026-11-02', 540, 'America/New_York'))).toBe('2026-11-02T14:00:00.000Z');
  });

  test('a time that happens twice still resolves to one of them', () => {
    const at = time.zonedTime('2026-10-25', 90, 'Europe/London');
    expect(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']).toContain(iso(at));
  });

  test('local parts and labels are in the business zone, not the server one', () => {
    const at = new Date('2026-07-15T23:30:00Z');
    expect(time.localParts(at, 'Asia/Tokyo').date).toBe('2026-07-16');
    expect(time.localParts(at, 'Asia/Tokyo').weekday).toBe(4);
    expect(time.formatLabel(new Date('2026-07-15T08:15:00Z'), 'Europe/London')).toBe('Wed 15 Jul, 09:15');
  });

  test('a zone Intl does not know is reported, not thrown on later', () => {
    expect(time.isValidTimezone('Europe/London')).toBe(true);
    expect(time.isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(time.isValidTimezone('')).toBe(false);
  });
});

describe('free times inside opening hours', () => {
  test('the same local hours across the change to summer time', () => {
    const slots = time.openingSlots({
      hours: ALL_WEEK(540, 600),
      timezone: 'Europe/London',
      from: new Date('2026-03-27T00:00:00Z'),
      to: new Date('2026-03-31T00:00:00Z'),
      duration: 30
    });

    expect(slots.map(slot => iso(slot.start))).toEqual([
      '2026-03-27T09:00:00.000Z', '2026-03-27T09:30:00.000Z',
      '2026-03-28T09:00:00.000Z', '2026-03-28T09:30:00.000Z',
      // Sunday the 29th: summer time, so 09:00 local is 08:00 UTC.
      '2026-03-29T08:00:00.000Z', '2026-03-29T08:30:00.000Z',
      '2026-03-30T08:00:00.000Z', '2026-03-30T08:30:00.000Z'
    ]);
    slots.forEach(slot => {
      expect(time.localParts(slot.start, 'Europe/London').minutes).toBeGreaterThanOrEqual(540);
      expect(slot.end - slot.start).toBe(30 * 60000);
    });
  });

  test('an appointment must end by closing time', () => {
    const slots = time.openingSlots({
      hours: ALL_WEEK(540, 660),
      timezone: 'UTC',
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-02T00:00:00Z'),
      duration: 60
    });
    // Starts every hour (the step is capped at 60): 09:00 and 10:00, not 10:30.
    expect(slots.map(slot => iso(slot.start))).toEqual(['2026-06-01T09:00:00.000Z', '2026-06-01T10:00:00.000Z']);
  });

  test('busy times and the buffer either side of them are kept clear', () => {
    const slots = time.openingSlots({
      hours: ALL_WEEK(540, 720),
      timezone: 'UTC',
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-02T00:00:00Z'),
      duration: 30,
      buffer: 15,
      busy: [{ start: '2026-06-01T10:00:00Z', end: '2026-06-01T11:00:00Z' }]
    });

    // 09:30 would end at 10:00, leaving no buffer before the 10:00 event;
    // 11:00 starts with no buffer after it. 11:30 has its fifteen minutes.
    expect(slots.map(slot => iso(slot.start))).toEqual([
      '2026-06-01T09:00:00.000Z', '2026-06-01T11:30:00.000Z'
    ]);
  });

  test('busy times are compared in absolute time whatever the business zone', () => {
    const slots = time.openingSlots({
      hours: ALL_WEEK(540, 660),
      timezone: 'America/New_York',
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-02T04:00:00Z'),
      duration: 60,
      // 09:00-10:00 New York time in June is 13:00-14:00 UTC.
      busy: [{ start: '2026-06-01T13:00:00Z', end: '2026-06-01T14:00:00Z' }]
    });
    expect(slots.map(slot => iso(slot.start))).toEqual(['2026-06-01T14:00:00.000Z']);
  });

  test('closed days and closed dates offer nothing', () => {
    const hours = ALL_WEEK(540, 600).map(rule => (rule.day === 6 ? { ...rule, closed: true } : rule));
    const slots = time.openingSlots({
      hours,
      timezone: 'UTC',
      // Friday 5 to Sunday 7 June 2026.
      from: new Date('2026-06-05T00:00:00Z'),
      to: new Date('2026-06-08T00:00:00Z'),
      duration: 60,
      closedDates: ['2026-06-07']
    });
    expect(slots.map(slot => iso(slot.start))).toEqual(['2026-06-05T09:00:00.000Z']);
  });

  test('nothing before `from`, so minimum notice holds', () => {
    const slots = time.openingSlots({
      hours: ALL_WEEK(540, 720),
      timezone: 'UTC',
      from: new Date('2026-06-01T10:10:00Z'),
      to: new Date('2026-06-01T23:00:00Z'),
      duration: 30
    });
    expect(iso(slots[0].start)).toBe('2026-06-01T10:30:00.000Z');
  });
});

describe('slot ids', () => {
  test('carry the service and the start, and nothing else', () => {
    const id = time.encodeSlotId('svc_1', new Date('2026-06-01T09:00:00Z'));
    expect(id).toBe('svc_1@2026-06-01T09:00:00.000Z');
    expect(time.decodeSlotId(id)).toEqual({ serviceId: 'svc_1', start: new Date('2026-06-01T09:00:00Z') });
  });

  test('a service id may itself contain @', () => {
    expect(time.decodeSlotId('a@b@2026-06-01T09:00:00.000Z').serviceId).toBe('a@b');
  });

  test.each(['', 'nonsense', '@2026-06-01T09:00:00Z', 'svc@not-a-date'])('%p is refused', value => {
    expect(time.decodeSlotId(value)).toBeNull();
  });
});

describe('choosing which slots to offer', () => {
  const day = (date, hours) => hours.map(hour => ({
    id: `s@${date}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    startsAt: `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`
  }));

  test('spread over more than one morning', () => {
    const slots = [...day('2026-06-01', [9, 10, 11, 12, 13, 14]), ...day('2026-06-02', [9, 10, 11, 12])];
    const picked = time.pickSlots(slots, 6, 'UTC');
    expect(picked.map(slot => slot.startsAt.slice(0, 13))).toEqual([
      '2026-06-01T09', '2026-06-01T10', '2026-06-01T11',
      '2026-06-02T09', '2026-06-02T10', '2026-06-02T11'
    ]);
  });

  test('one day with plenty still fills every place', () => {
    const picked = time.pickSlots(day('2026-06-01', [9, 10, 11, 12, 13, 14, 15]), 6, 'UTC');
    expect(picked).toHaveLength(6);
  });

  test('duplicates are dropped', () => {
    const slots = day('2026-06-01', [9, 9, 10]);
    expect(time.pickSlots(slots, 6, 'UTC')).toHaveLength(2);
  });
});
