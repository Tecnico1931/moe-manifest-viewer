import { Component, Input } from '@angular/core';
import { ViewerState } from '../../shared';

@Component({
  selector: 'app-edge-view',
  templateUrl: './edge-view.component.html',
  styleUrls: ['./edge-view.component.scss'],
})
export class EdgeViewComponent {
  @Input() public viewerState: ViewerState;
}
