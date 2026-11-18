import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { DEFAULT_DEVICE_PROFILE_ID, DeviceProfile } from '../../shared/models/device-profiles';
import { resolveDeviceProfile } from './device-profile.logic';

const STORAGE_KEY = 'MV_DEVICE_PROFILE';
const URL_VAR = 'deviceProfile';

/**
 * Holds the active device profile per viewer. A new viewer starts from the `deviceProfile=<id>` URL var,
 * else from the last profile chosen (persisted in localStorage), else Default.
 */
@Injectable({ providedIn: 'root' })
export class DeviceProfileService {
  private profiles = new Map<string, BehaviorSubject<DeviceProfile>>();

  public profile$(viewerId: string): Observable<DeviceProfile> {
    return this.subject(viewerId).asObservable();
  }

  public get(viewerId: string): DeviceProfile {
    return this.subject(viewerId).value;
  }

  public set(viewerId: string, profileId: string): void {
    const profile = resolveDeviceProfile(profileId);
    this.subject(viewerId).next(profile);
    try {
      localStorage.setItem(STORAGE_KEY, profile.id);
    } catch (e) {
      // storage unavailable (private mode): the choice just isn't remembered
    }
  }

  private subject(viewerId: string): BehaviorSubject<DeviceProfile> {
    let subject = this.profiles.get(viewerId);
    if (!subject) {
      subject = new BehaviorSubject<DeviceProfile>(resolveDeviceProfile(this.initialId()));
      this.profiles.set(viewerId, subject);
    }
    return subject;
  }

  private initialId(): string {
    const fromUrl = new URLSearchParams(location.search).get(URL_VAR);
    if (fromUrl) {
      return fromUrl;
    }
    try {
      return localStorage.getItem(STORAGE_KEY) || DEFAULT_DEVICE_PROFILE_ID;
    } catch (e) {
      return DEFAULT_DEVICE_PROFILE_ID;
    }
  }
}
