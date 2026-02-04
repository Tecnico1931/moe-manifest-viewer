import { Component, OnInit, Input, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs/index';

import { ParsedManifest, ViewerState, ParserService, DataService, Subtitles, ManifestLineObject } from '../../shared';

import { takeUntil } from 'rxjs/operators';

export interface ManifestLevel {
  isStall?: boolean;
  lastFragSeenCount?: number;
  uri: string;
  status: string;
  fullUrl?: string;
  lastFrag?: string;
  lastFragNumber?: string;
  isLive?: boolean;
  isRollback?: boolean;
  prevFragNumber?: number;
}

interface SubtitlesLine {
  start: number;
  end: number;
  text: string;
}

@Component({
  selector: 'app-subtitles-viewer',
  templateUrl: './subtitles-viewer.component.html',
  styleUrls: ['./subtitles-viewer.component.scss'],
})
export class SubtitlesViewerComponent implements OnInit, OnDestroy {
  @Input() public manifestUpdate$: BehaviorSubject<ParsedManifest | null>;
  @Input() public viewerState: ViewerState;

  public manifestLevels: ManifestLevel[];
  public showMasterUrl: boolean;
  public urlText = 'Show Master Url';
  public subtitles: Subtitles[];
  public selectedSubtitles: Subtitles;
  public subtitlesLine: SubtitlesLine[];
  private currentEnd: number = 0;
  private currentTime: number = 0;
  private ngUnsubscribe: Subject<void> = new Subject<void>();
  private subtitleIndex: number = 0;
  private subtitleManifest: ManifestLineObject[];

  constructor(private dataService: DataService, private parserService: ParserService) {}

  public async ngOnInit() {
    this.subtitlesLine = [];
    this.viewerState.currentDisplayTime$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.handleTime);
    this.viewerState.selectedSubtitles$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.handleSelectedSubtitles);
    this.viewerState.subtitles$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(this.handleSubtitles);
    this.subtitleIndex = this.viewerState.subtitles.findIndex((element) => element?.name === this.viewerState.selectedSubtitles?.name);
    await this.handleSubtitles(this.viewerState.subtitles);
  }

  public onChangeLanguage = (value: string) => {
    this.subtitleIndex = value !== 'none' ? this.viewerState.subtitles.findIndex((element) => element.name === value) : -1;
    this.handleSubtitles(this.viewerState.subtitles);
  };

  private parseSubtitleFile = async (text: string): Promise<void> => {
    const lines = text.split('\n');
    console.log('[SubtitlesViewer] Parsing subtitle file, total lines:', lines.length);
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('-->')) {
        const times = line.split('-->');
        const startTime = this.convertToSeconds(times[0]);
        const endTime = this.convertToSeconds(times[1]);
        
        let subtitleText = '';
        let j = i + 1;
        
        while (j < lines.length && lines[j].trim() !== '' && !lines[j].includes('-->')) {
          if (subtitleText) {
            subtitleText += '\n' + lines[j].trim();
          } else {
            subtitleText = lines[j].trim();
          }
          j++;
        }
        
        if (subtitleText) {
          this.subtitlesLine.push({
            start: startTime,
            end: endTime,
            text: subtitleText,
          });
        }
        
        i = j - 1;
      }
    }
    
    console.log('[SubtitlesViewer] Parsed subtitles, total captions:', this.subtitlesLine.length);
    if (this.subtitlesLine.length > 0) {
      console.log('[SubtitlesViewer] First caption:', this.subtitlesLine[0]);
      console.log('[SubtitlesViewer] Last caption:', this.subtitlesLine[this.subtitlesLine.length - 1]);
    }
  };

  private getSubtitles = async (manifestLineObject: ManifestLineObject) => {
    if (manifestLineObject.url) {
      const allText = ((await this.dataService.getManifest(manifestLineObject.url)).text ?? '').split('\n');
      allText.forEach((value, key) => {
        if (value.includes('-->')) {
          const times = value.split('-->');
          let lineKey = key + 1;
          let lineText = '';
          while (allText[lineKey] && !allText[lineKey]?.includes('-->')) {
            if (lineText) {
              lineText += `\n ${allText[lineKey]}`;
            } else {
              lineText = allText[lineKey];
            }
            lineKey = lineKey + 1;
          }
          this.subtitlesLine.push({
            start: this.convertToSeconds(times[0]),
            end: this.convertToSeconds(times[1]),
            text: lineText,
          });
        }
      });
      
      if (this.currentTime !== undefined) {
        const line = this.subtitlesLine?.find((subtitle) => subtitle.start <= this.currentTime && subtitle.end > this.currentTime);
        if (line) {
          this.currentEnd = line.end;
          this.viewerState.updateCaption(line.text);
        }
      }
    }
  };

  private convertToSeconds = (time: string) => {
    const timeValues = time.replace(/\s+/g, '').split(':');
    switch (timeValues.length) {
      case 2:
        return Number(timeValues[0]) * 60 + Number(timeValues[1]);
      case 3:
        return Number(timeValues[0]) * 3600 + Number(timeValues[1]) * 60 + Number(timeValues[2]);
      default:
        return Number(timeValues[0]);
    }
  };

  private handleSubtitles = (subtitles: Subtitles[]): void => {
    if (!subtitles || subtitles.length === 0) {
      this.subtitlesLine = [];
      this.viewerState.updateCaption('');
      return;
    }
    
    let newSubtitles;
    if (this.subtitleIndex >= 0 && this.subtitleIndex < subtitles.length) {
      newSubtitles = subtitles[this.subtitleIndex];
      if (this.selectedSubtitles === newSubtitles) {
        return;
      }
    } else {
      this.subtitlesLine = [];
      this.viewerState.updateCaption('');
      return;
    }
    
    if (newSubtitles) {
      this.initSelectedSubtitles(newSubtitles);
      this.viewerState.updateSelectedSubtitles(this.selectedSubtitles as Subtitles);
    }
  };

  private handleSelectedSubtitles = (subtitle: Subtitles): void => {
    if (!subtitle) {
      this.subtitlesLine = [];
      this.viewerState.updateCaption('');
      return;
    }
    
    if (this.selectedSubtitles === subtitle) {
      return;
    }
    this.initSelectedSubtitles(subtitle);
  };

  private async initSelectedSubtitles(subtitle: Subtitles): Promise<void> {
    if (!subtitle) {
      this.selectedSubtitles = {} as Subtitles;
      this.subtitlesLine = [];
      this.subtitleManifest = [];
      this.viewerState.updateCaption('');
      return;
    }
    
    this.selectedSubtitles = subtitle;
    this.subtitlesLine = [];
    
    if (this.selectedSubtitles?.url) {
      const url = this.selectedSubtitles.url;
      const isSingleVttFile = url.includes('.vtt') || url.includes('.webvtt') || url.includes('.srt');
      
      if (isSingleVttFile) {
        console.log('[SubtitlesViewer] Loading single VTT/SRT file:', url);
        const subtitleContent = await this.dataService.getManifest(url);
        await this.parseSubtitleFile(subtitleContent.text || '');
        console.log('[SubtitlesViewer] Current time:', this.currentTime);
        
        if (this.currentTime !== undefined) {
          const line = this.subtitlesLine?.find((subtitle) => subtitle.start <= this.currentTime && subtitle.end > this.currentTime);
          if (line) {
            console.log('[SubtitlesViewer] Found matching caption at init:', line);
            this.currentEnd = line.end;
            this.viewerState.updateCaption(line.text);
          } else {
            console.log('[SubtitlesViewer] No caption found for current time:', this.currentTime);
          }
        }
      } else {
        let receivedSubtitleManifest = await this.dataService.getManifest(this.selectedSubtitles.url).then(this.parserService.parseManifest);
        this.subtitleManifest = receivedSubtitleManifest.lines?.filter((line) => line.startTime !== undefined && line.stream);
        
        if (this.subtitleManifest && this.subtitleManifest.length > 0 && this.currentTime !== undefined) {
          const initialSegment = this.subtitleManifest.find((value) => {
            const startTime = value.startTime;
            const fragDuration = value.fragDuration;
            return startTime !== undefined && fragDuration && startTime <= this.currentTime && startTime + fragDuration > this.currentTime;
          });
          if (initialSegment) {
            await this.getSubtitles(initialSegment);
            initialSegment.loadStatus = 'loaded';
          }
        }
      }
    } else {
      this.subtitleManifest = [];
    }
  }

  private handleTime = (seconds: number) => {
    this.currentTime = seconds;
    
    const line = this.subtitlesLine?.find((subtitle) => subtitle.start <= seconds && subtitle.end > seconds);
    
    if (line) {
      if (this.currentEnd !== line.end) {
        this.currentEnd = line.end;
        this.viewerState.updateCaption(line.text);
      }
    } else {
      if (this.currentEnd !== 0) {
        this.currentEnd = 0;
        this.viewerState.updateCaption('');
      }
      
      if (this.subtitleManifest) {
        const nextPossibleManifest = this.subtitleManifest.find((value, key) => {
          const startTime = value.startTime;
          const fragDuration = value.fragDuration;
          if (startTime !== undefined && fragDuration && value.loadStatus !== 'loaded') {
            const isInRange = startTime <= seconds && startTime + fragDuration > seconds;
            if (isInRange) {
              this.subtitleManifest[key].loadStatus = 'loaded';
            }
            return isInRange;
          }
          return false;
        });
        if (nextPossibleManifest) {
          this.getSubtitles(nextPossibleManifest);
        }
      }
    }
  };

  public ngOnDestroy() {
    this.viewerState.updateCaption('');
    this.ngUnsubscribe.next();
  }
}
