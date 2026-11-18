import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AudioTrack, ViewerState } from '../../shared/services/viewer-state';

/** Toolbar dropdown to switch the HLS.js player between alternate audio renditions (e.g. Mixed / Instructor / Music). */
@Component({
  selector: 'app-audio-track-select',
  templateUrl: './audio-track-select.component.html',
  styleUrls: ['./audio-track-select.component.scss'],
})
export class AudioTrackSelectComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;
  public tracks: AudioTrack[] = [];
  public selectedId: number | null = null;
  private ngUnsubscribe = new Subject<void>();

  public ngOnInit(): void {
    this.viewerState.audioTracks$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((tracks) => {
      this.tracks = tracks || [];
      if (this.selectedId === null || !this.tracks.some((t) => t.id === this.selectedId)) {
        const active = this.viewerState.selectedAudioTrack || this.tracks.find((t) => t.default) || this.tracks[0];
        this.selectedId = active ? active.id : null;
      }
    });
    this.viewerState.selectedAudioTrack$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((track) => {
      this.selectedId = track ? track.id : this.selectedId;
    });
  }

  public ngOnDestroy(): void {
    this.ngUnsubscribe.next();
    this.ngUnsubscribe.complete();
  }

  public label(t: AudioTrack): string {
    return t.lang && t.name.indexOf(t.lang) < 0 ? `${t.name} (${t.lang})` : t.name;
  }

  public select(value: string): void {
    const id = Number(value);
    this.selectedId = id;
    this.viewerState.requestAudioTrackChange(id);
  }
}
