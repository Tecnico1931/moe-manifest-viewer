import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { ViewerState } from '../../shared';
import { WhisperService, WhisperState, WhisperCaption, WhisperModelInfo, WhisperTask } from '../../shared/services/whisper.service';

@Component({
  selector: 'app-whisper-subtitles',
  templateUrl: './whisper-subtitles.component.html',
  styleUrls: ['./whisper-subtitles.component.scss'],
})
export class WhisperSubtitlesComponent implements OnInit, OnDestroy {
  @Input() public viewerState: ViewerState;

  public models: WhisperModelInfo[] = WhisperService.MODELS;
  public selectedModelId: string = WhisperService.MODELS[0].id;

  public whisperState: WhisperState = 'idle';
  public modelProgress = 0;
  public transcriptionProgress = 0;
  public errorMessage = '';
  public captions: WhisperCaption[] = [];

  public mode: 'segments' | 'microphone' = 'segments';
  public task: WhisperTask = 'transcribe';

  public inPoint = 0;
  public outPoint = 0;
  public videoDuration = 0;

  public showOverlay = true;
  public isMicActive = false;

  private fragments: any[] = [];
  private ngUnsubscribe: Subject<void> = new Subject<void>();

  constructor(private whisperService: WhisperService) {}

  public ngOnInit(): void {
    this.viewerState.totalDuration$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((duration) => {
      this.videoDuration = duration;
      if (this.outPoint === 0 || this.outPoint > duration) {
        this.outPoint = duration;
      }
    });

    this.viewerState.fragments$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((frags) => {
      this.fragments = frags;
    });

    this.viewerState.currentDisplayTime$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((time) => {
      if (this.showOverlay && this.captions.length > 0) {
        this.whisperService.updateCaptionForTime(time);
      }
    });

    this.whisperService.state$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((state) => {
      this.whisperState = state;
    });

    this.whisperService.modelProgress$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((progress) => {
      this.modelProgress = progress;
    });

    this.whisperService.transcriptionProgress$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((progress) => {
      this.transcriptionProgress = progress;
    });

    this.whisperService.captions$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((captions) => {
      this.captions = captions;
    });

    this.whisperService.error$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((error) => {
      this.errorMessage = error;
    });

    this.whisperService.currentCaption$.pipe(takeUntil(this.ngUnsubscribe)).subscribe((caption) => {
      if (this.showOverlay) {
        this.viewerState.updateCaption(caption);
      }
    });
  }

  public ngOnDestroy(): void {
    this.whisperService.cancel();
    if (this.showOverlay) {
      this.viewerState.updateCaption('');
    }
    this.ngUnsubscribe.next();
  }

  public isModelLoaded(): boolean {
    return this.whisperService.isModelLoaded();
  }

  public async loadModel(): Promise<void> {
    this.errorMessage = '';
    try {
      await this.whisperService.loadModel(this.selectedModelId);
    } catch (e) {
      // Error handled by service
    }
  }

  public setInPointFromPlayhead(): void {
    if (this.viewerState.currentTime != null) {
      this.inPoint = Math.floor(this.viewerState.currentTime * 100) / 100;
      if (this.inPoint >= this.outPoint) {
        this.outPoint = Math.min(this.inPoint + 1, this.videoDuration);
      }
    }
  }

  public setOutPointFromPlayhead(): void {
    if (this.viewerState.currentTime != null) {
      this.outPoint = Math.floor(this.viewerState.currentTime * 100) / 100;
      if (this.outPoint <= this.inPoint) {
        this.inPoint = Math.max(this.outPoint - 1, 0);
      }
    }
  }

  public async startTranscription(): Promise<void> {
    this.errorMessage = '';

    if (this.mode === 'segments') {
      if (this.fragments.length === 0) {
        this.errorMessage = 'No segments available. Make sure a stream is loaded and playing.';
        return;
      }
      await this.whisperService.transcribeSegments(this.fragments, this.inPoint, this.outPoint, this.viewerState.xhrCredentials, this.task);
    } else {
      this.isMicActive = true;
      await this.whisperService.startMicrophoneTranscription(this.task);
    }
  }

  public stopMicrophone(): void {
    this.isMicActive = false;
    this.whisperService.stopMicrophoneTranscription();
  }

  public cancelTranscription(): void {
    this.isMicActive = false;
    this.whisperService.cancel();
  }

  public clearCaptions(): void {
    this.whisperService.clearCaptions();
    this.viewerState.updateCaption('');
  }

  public toggleOverlay(): void {
    this.showOverlay = !this.showOverlay;
    if (!this.showOverlay) {
      this.viewerState.updateCaption('');
    }
  }

  public exportVTT(): void {
    const vtt = this.whisperService.exportAsVTT();
    this.downloadFile(vtt, 'subtitles.vtt', 'text/vtt');
  }

  public exportSRT(): void {
    const srt = this.whisperService.exportAsSRT();
    this.downloadFile(srt, 'subtitles.srt', 'text/srt');
  }

  public formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) {
      return '00:00.00';
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    if (h > 0) {
      return this.pad(h) + ':' + this.pad(m) + ':' + this.pad(s) + '.' + this.pad(ms);
    }
    return this.pad(m) + ':' + this.pad(s) + '.' + this.pad(ms);
  }

  public seekToCaption(caption: WhisperCaption): void {
    if (caption.start > 0) {
      this.viewerState.updateTime(caption.start);
    }
  }

  private pad(n: number): string {
    return n < 10 ? '0' + n : '' + n;
  }

  private downloadFile(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
