import { Component, Input, OnDestroy, OnInit, ChangeDetectorRef } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { DEVICE_PROFILES, DeviceProfile } from '../../shared/models/device-profiles';
import { VideoPlayers } from '../../shared/models/video-players';
import { DeviceProfileService } from './device-profile.service';
import { describeProfile, isNoopProfile } from './device-profile.logic';

export const THROTTLE_TOOLTIP =
  'Simulated device profile (approximate values, see device-profiles.ts). Throttling only slows responses after they arrive ' +
  '(delay = latency + bytes*8/cap); it cannot speed up a slow network, so real throughput can be lower than the cap.';

/** `select` is the dropdown for the toolbar; `chip` is the small active-profile badge for the player area. */
@Component({
  selector: 'app-device-profile',
  templateUrl: './device-profile.component.html',
  styleUrls: ['./device-profile.component.scss'],
})
export class DeviceProfileComponent implements OnInit, OnDestroy {
  @Input() public viewerId: string;
  @Input() public mode: 'select' | 'chip' = 'select';
  @Input() public selectedPlayer: VideoPlayers;

  public profiles = DEVICE_PROFILES;
  public profile: DeviceProfile;
  public tooltip = THROTTLE_TOOLTIP;
  private ngUnsubscribe = new Subject<void>();

  constructor(private service: DeviceProfileService, private cdr: ChangeDetectorRef) {}

  public get hlsOnly(): boolean {
    return !!this.selectedPlayer && this.selectedPlayer !== VideoPlayers.HLS_PLAYER && this.selectedPlayer !== VideoPlayers.NONE;
  }

  public get isActive(): boolean {
    return !!this.profile && !isNoopProfile(this.profile);
  }

  public get summary(): string {
    return this.profile ? `${this.profile.label}: ${describeProfile(this.profile)}. ${this.tooltip}` : '';
  }

  public ngOnInit(): void {
    this.service
      .profile$(this.viewerId)
      .pipe(takeUntil(this.ngUnsubscribe))
      .subscribe((profile) => {
        this.profile = profile;
        this.cdr.markForCheck();
      });
  }

  public ngOnDestroy(): void {
    this.ngUnsubscribe.next();
    this.ngUnsubscribe.complete();
  }

  public onSelect(profileId: string): void {
    this.service.set(this.viewerId, profileId);
  }
}
