import { Component, Input } from '@angular/core';
import { ViewerState } from '../../shared';

@Component({
  selector: 'app-bitrate-audit',
  templateUrl: './bitrate-audit.component.html',
  styleUrls: ['./bitrate-audit.component.scss'],
})
export class BitrateAuditComponent {
  @Input() public viewerState: ViewerState;
}
