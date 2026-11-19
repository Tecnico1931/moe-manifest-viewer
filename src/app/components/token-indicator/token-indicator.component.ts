import { Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { describeRemaining, isTokenExpired, parseToken, TokenInfo, TokenState } from '../../shared/token-safety.logic';

@Component({
  selector: 'app-token-indicator',
  template: `<span *ngIf="info" class="tokenIndicator" [ngClass]="state" [title]="tooltip">Token: {{ text }}</span>`,
  styles: [
    `
      .tokenIndicator {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 3px;
        border: 1px solid currentColor;
        white-space: nowrap;
        cursor: default;
      }
      .ok {
        color: #7cc576;
      }
      .warn {
        color: #f5a623;
      }
      .expired {
        color: #e5534b;
      }
    `,
  ],
})
export class TokenIndicatorComponent implements OnInit, OnChanges, OnDestroy {
  /** Full URL (with query). Only exp/acl are read from it; it is never logged or stored. */
  @Input() public url: string;
  /** Last manifest response status; a 403 with an expired token raises a toast. */
  @Input() public status: number | undefined;

  public info: TokenInfo | null = null;
  public text = '';
  public state: TokenState = 'ok';
  public tooltip = '';
  private timer: any;

  constructor(private toastrService: ToastrService) {}

  public ngOnInit() {
    this.timer = setInterval(this.refresh, 1000);
  }

  public ngOnChanges(changes: SimpleChanges) {
    if (changes.url) {
      this.info = parseToken(this.url);
      this.refresh();
    }
    if (changes.status && this.status === 403 && isTokenExpired(this.url, Date.now())) {
      this.toastrService.error('Token expired — get a new URL', 'Request denied (403)');
    }
  }

  public ngOnDestroy() {
    clearInterval(this.timer);
  }

  private refresh = () => {
    const info = this.info;
    if (!info) {
      return;
    }
    if (info.exp === undefined) {
      this.text = 'no exp';
      this.state = 'ok';
    } else {
      const r = describeRemaining(info.exp, Date.now());
      this.text = r.text;
      this.state = r.state;
    }
    this.tooltip = `${info.name}${info.acl ? ' acl: ' + info.acl : ''}`;
  };
}
