import { Component, Input } from '@angular/core';
import { ViewerState } from '../../shared';

@Component({
  selector: 'app-ladder-check',
  templateUrl: './ladder-check.component.html',
  styleUrls: ['./ladder-check.component.scss'],
})
export class LadderCheckComponent {
  @Input() public viewerState: ViewerState;
}
