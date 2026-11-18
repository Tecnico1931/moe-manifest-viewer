import { Component, Input } from '@angular/core';
import { ViewerState } from '../../shared';

@Component({
  selector: 'app-startup-waterfall',
  templateUrl: './startup-waterfall.component.html',
  styleUrls: ['./startup-waterfall.component.scss'],
})
export class StartupWaterfallComponent {
  @Input() public viewerState: ViewerState;
}
