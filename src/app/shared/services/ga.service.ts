import { Injectable } from '@angular/core';

// Analytics are disabled in the Peloton build. Call sites are kept so the diff stays small.
@Injectable()
export class GoogleAnalyticsEventsService {
  constructor() {}
  public emitEvent(eventCategory: string, eventAction: any, eventLabel: string): void {}
}
