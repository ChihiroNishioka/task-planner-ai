export class MockCalendarAdapter {
  readonly mode = 'mock' as const;
  readonly label = 'モック' as const;

  listEvents(): [] {
    return [];
  }
}
