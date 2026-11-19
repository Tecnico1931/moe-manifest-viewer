import { Component, EventEmitter, Input, Output } from '@angular/core';
import { SINGLE_BITRATE_OPTIONS } from './single-bitrate.logic';

/** Toolbar dropdown for the Peloton single-bitrate EdgeWorker (`?rendition=` on the master manifest). */
@Component({
  selector: 'app-single-bitrate-select',
  templateUrl: './single-bitrate-select.component.html',
  styleUrls: ['./single-bitrate-select.component.scss'],
})
export class SingleBitrateSelectComponent {
  /** Current `rendition` value ('' = full ladder). */
  @Input() public current = '';
  @Output() public renditionChange = new EventEmitter<string>();
  public readonly options = SINGLE_BITRATE_OPTIONS;

  public get isCustom(): boolean {
    return !!this.current && !this.options.some((o) => o.key === this.current);
  }

  public select(key: string): void {
    if (key !== this.current) {
      this.renditionChange.emit(key);
    }
  }
}
