import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { UrlVars, VarNames } from '../models/url-vars.model';

@Injectable()
export class UrlVarsService {
  public urlVars = new UrlVars({});
  public hlsjsConfig = {};

  constructor() {
    this.setUrlVars();
  }

  public setUrlVars() {
    const queryString = require('query-string');
    // Parameters may come after "?" or "#". The redirect extension uses "#" so manifest tokens (hdntl etc.)
    // stay in the browser and never reach the hosting server's logs. Fragment values win over query ones.
    const raw = [location.search.replace(/^\?/, ''), location.hash.replace(/^#/, '')].filter(Boolean).join('&');
    const parsed = queryString.parse(raw);
    const qs = {};
    const queryParams = queryString.stringify(parsed);
    const urlParams: string = queryParams;
    if (urlParams) {
      const pairs: string[] = urlParams.split('&');
      for (const eachParam of pairs) {
        const key = eachParam.split('=')[0];
        qs[key] = eachParam.slice(key.length + 1);
      }
    }
    this.apply(qs);
  }

  public apply(obj: any): void {
    this.urlVars = new UrlVars(obj);
    for (const i in obj) {
      if (i.indexOf('hlsjs.') === 0) {
        if (obj[i] === 'true') {
          this.hlsjsConfig[i.substr(6)] = true;
        } else if (obj[i] === 'false') {
          this.hlsjsConfig[i.substr(6)] = false;
        } else {
          this.hlsjsConfig[i.substr(6)] = Number(obj[i]);
        }
      }
    }
  }
}
