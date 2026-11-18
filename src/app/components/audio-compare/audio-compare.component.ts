import { Component, Input } from '@angular/core';
import { ViewerState } from '../../shared';

@Component({
  selector: 'app-audio-compare',
  templateUrl: './audio-compare.component.html',
  styleUrls: ['./audio-compare.component.scss'],
})
export class AudioCompareComponent {
  @Input() public viewerState: ViewerState;
}
