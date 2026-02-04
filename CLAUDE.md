# CLAUDE.md - AI Assistant Guide for MOE Manifest Viewer

This document provides comprehensive guidance for AI assistants working with the MOE Manifest Viewer codebase.

## Project Overview

**MOE: Viewer** is an Angular-based web application for displaying, analyzing, and playing HLS/DASH streaming video manifests. It provides a unified interface to inspect manifest structures, analyze stream characteristics, play video content, and monitor playback metrics.

- **Repository**: https://github.com/realeyes-media/moe-manifest-viewer
- **Production URL**: https://mv.realeyes.cloud/
- **License**: MIT

### Key Features
- Display and analyze HLS (HTTP Live Streaming) and DASH manifests
- Real-time playback using multiple player engines (hls.js, dash.js, Shaka Player)
- Metrics tracking, stall detection, DRM support, and CMCD integration
- Support for live and VOD streams
- Multi-viewer interface with tabs

## Tech Stack

| Category | Technology | Version |
|----------|------------|---------|
| Framework | Angular | 9.1.13 |
| Language | TypeScript | 3.8.3 |
| Reactive | RxJS | 6.6.3 |
| HLS Player | hls.js | 1.3.2 |
| DASH/HLS Player | Shaka Player | 4.7.1 |
| Charts | Chartist | 0.11.0 |
| Notifications | ngx-toastr | 13.2.1 |
| Testing | Jasmine + Karma | 3.5.0 / 5.0.0 |
| E2E | Protractor | 7.0.0 |
| Linting | TSLint | 6.1.0 |
| Formatting | Prettier | 2.2.1 |

**Node Requirement**: Node 14.x is required

## Directory Structure

```
/moe-manifest-viewer/
├── src/
│   ├── app/
│   │   ├── app.component.*          # Root component
│   │   ├── app.module.ts            # Main Angular module
│   │   ├── components/              # Feature components (31+)
│   │   │   ├── hls-player/          # HLS.js player integration
│   │   │   ├── dash-player/         # DASH.js player integration
│   │   │   ├── shaka-player/        # Shaka Player integration
│   │   │   ├── manifest-viewer/     # Core manifest display
│   │   │   ├── wrapper/             # Main wrapper managing viewers
│   │   │   ├── options-modal/       # Settings/configuration
│   │   │   ├── metrics-dropdown/    # Video metrics display
│   │   │   ├── stall-detector/      # Stall detection
│   │   │   ├── segment-inspector/   # Segment URL inspection
│   │   │   ├── cmcd/                # CMCD component
│   │   │   ├── drm-modal/           # DRM configuration
│   │   │   └── ...                  # Other components
│   │   ├── shared/
│   │   │   ├── services/            # Core injectable services
│   │   │   ├── models/              # TypeScript interfaces
│   │   │   ├── pipes/               # Angular custom pipes
│   │   │   ├── utils/               # Utility functions
│   │   │   └── index.ts             # Barrel exports
│   │   └── environments/            # Environment configs
│   ├── assets/                      # Static assets
│   ├── main.ts                      # Entry point
│   ├── polyfills.ts                 # Browser polyfills
│   ├── styles.scss                  # Global styles
│   └── index.html                   # Root HTML
├── e2e/                             # End-to-end tests
├── dist/                            # Build output (generated)
├── angular.json                     # Angular CLI config
├── tsconfig.json                    # TypeScript config
├── tslint.json                      # Linting rules
├── karma.conf.js                    # Test runner config
├── package.json                     # Dependencies and scripts
├── .prettierrc                      # Prettier config
├── Dockerfile                       # Production Docker image
└── docker-compose.yml               # Local Docker deployment
```

## Key Services

| Service | File | Purpose |
|---------|------|---------|
| AppService | `shared/services/app.service.ts` | Central event/state management via RxJS subjects |
| ParserService | `shared/services/parser.service.ts` | HLS, DASH, VTT manifest parsing |
| ViewerState | `shared/services/viewer-state.ts` | Per-viewer state management |
| StorageService | `shared/services/storage.service.ts` | Local storage management |
| DataService | `shared/services/data.service.ts` | HTTP fetch for manifests |
| UrlVarsService | `shared/services/url-vars.service.ts` | Query parameter handling |
| DrmManagerService | `shared/services/drm-manager.service.ts` | DRM integration |

## Key Models

| Model | File | Purpose |
|-------|------|---------|
| ManifestLineObject | `shared/models/manifest-line-object.ts` | Parsed manifest line structure |
| StreamInfo | `shared/models/manifest-line-object.ts` | HLS/DASH stream metadata |
| Viewer | `shared/models/viewer.ts` | Viewer instance interface |
| QueryOptions | `shared/models/url-vars.model.ts` | URL parameter configuration |
| VideoPlayers | `shared/models/video-players.ts` | Player type enums |

## Development Commands

```bash
# Install dependencies (requires Node 14.x)
npm install

# Start development server (http://localhost:4200)
npx ng serve

# Build for production
npm run build
# or: ng build --prod --aot

# Run unit tests
npm test

# Run linting
npm run lint

# Run E2E tests
npm run e2e

# Start with http-server (after build)
npm start

# Docker local build
docker-compose up --build
```

## Code Style and Conventions

### TypeScript

- **Strict null checks** enabled (`strictNullChecks: true`)
- **Single quotes** for strings
- **Max line length**: 140 characters
- **Private properties**: Use underscore prefix (e.g., `_showVideo`)
- **Classes**: PascalCase
- **Properties/methods**: camelCase

### Components

- **Prefix**: `app-` (e.g., `<app-wrapper>`, `<app-manifest-viewer>`)
- **Structure**: Each component has `.ts`, `.html`, `.scss`, and optionally `.spec.ts`
- **Lifecycle**: Use `OnInit` and `OnDestroy` interfaces

### RxJS Patterns

```typescript
// Subject usage
public showVideo$ = new Subject<boolean>();
public muteVideo$ = new BehaviorSubject<boolean>(initialValue);

// Subscription cleanup with takeUntil
private ngUnsubscribe: Subject<void> = new Subject<void>();

observable$.pipe(takeUntil(this.ngUnsubscribe)).subscribe(...);

ngOnDestroy() {
  this.ngUnsubscribe.next();
}

// Async pipe in templates
{{ observable$ | async }}
```

### SCSS

- Import shared variables from `shared/utils/vars.scss`
- Use semantic class names
- Global styles in `src/styles.scss`

## Pre-commit Hooks

Husky runs automatically before commits:
1. `npm run format:fix` - Prettier formatting on staged files
2. `npm run lint` - TSLint on all src/ files

Both must pass for the commit to succeed.

## Commit Message Convention

Format: `MOEV-XXXX description`

Use JIRA-style ticket references. Examples:
- `MOEV-1234 add dark mode toggle`
- `MOEV-0000 fix typo in readme`

## Testing

### Unit Tests
- Framework: Jasmine + Karma
- Pattern: `**/*.spec.ts`
- Run: `npm test`

### E2E Tests
- Framework: Protractor
- Location: `e2e/src/`
- Run: `npm run e2e`

### Test Pattern
```typescript
describe('ComponentName', () => {
  let component: ComponentName;
  let fixture: ComponentFixture<ComponentName>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ComponentName],
    }).compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ComponentName);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
```

## Key Architecture Patterns

### State Management
- **No Redux/NgRx** - Uses RxJS Subjects via AppService
- **Per-viewer state** managed by ViewerState instances
- **Persistence** via StorageService (localStorage)

### Player Architecture
Players are modular and interchangeable:
- `HlsPlayerComponent` - hls.js wrapper
- `DashPlayerComponent` - dash.js wrapper
- `ShakaPlayerComponent` - Shaka Player (supports both HLS/DASH)

### Manifest Parsing
- ParserService handles HLS, DASH, and VTT formats
- Uses regex-based parsing (see `hls-regex.model.ts`)
- Supports master and variant manifests

### HTTP/Fetch
- Uses native Fetch API (not Angular HttpClient)
- CORS handling via `xhrCredentials` option
- No-store cache policy for manifests

## Important Files to Know

| File | Why It Matters |
|------|----------------|
| `src/app/app.module.ts` | All component/service declarations |
| `src/app/shared/services/app.service.ts` | Central state/events (30+ subjects) |
| `src/app/shared/services/parser.service.ts` | Manifest parsing logic |
| `src/app/components/manifest-viewer/` | Core manifest display (~1000 lines) |
| `src/app/components/wrapper/` | Multi-viewer container |
| `src/main.ts` | Entry point with domain whitelisting |
| `angular.json` | Build configuration |
| `tsconfig.json` | TypeScript settings |

## Common Tasks for AI Assistants

### Adding a New Component
1. Create component in `src/app/components/`
2. Register in `app.module.ts` declarations
3. Follow existing component structure (`.ts`, `.html`, `.scss`)
4. Use `app-` prefix for selector

### Adding a New Service
1. Create service in `src/app/shared/services/`
2. Add `@Injectable()` decorator
3. Register in `app.module.ts` providers
4. Export from `src/app/shared/index.ts`

### Modifying Manifest Parsing
- Edit `parser.service.ts` for parsing logic
- Update regex patterns in `hls-regex.model.ts`
- Add new interfaces in `manifest-line-object.ts`

### Working with State
- Use AppService subjects for global state
- Use ViewerState for per-viewer state
- Subscribe with `takeUntil(ngUnsubscribe)` pattern

### Adding URL Parameters
1. Add to `url-vars.model.ts` QueryOptions interface
2. Handle in `url-vars.service.ts`
3. Document in README.md

## Build and Deployment

### Production Build
```bash
ng build --prod --aot
```
Output goes to `/dist/` directory.

### Docker
```bash
# Production container (nginx)
docker build -t moe-viewer .

# Local development
docker-compose up --build
# Exposes on port 8081
```

### Environment Files
- `src/app/environments/environment.ts` - Development
- `src/app/environments/environment.prod.ts` - Production

## Browser Support

Targets (from `browserslist`):
- Last 2 versions of major browsers
- Firefox ESR
- IE 9-11 (legacy support)

## Code Owners

Defined in `.github/CODEOWNERS`:
- @turbidwater
- @gregdolby
- @ngietka
- @dhassoun
- @coderjun

## Troubleshooting

### Common Issues

1. **Node version errors**: Ensure Node 14.x is installed
2. **Build failures with unused locals**: `noUnusedLocals` is commented out in tsconfig.json
3. **Pre-commit hook failures**: Run `npm run format:fix && npm run lint` manually to see errors
4. **Large manifest copy failures**: HTTPS required for `navigator.clipboard` API

### Debugging Tips
- Check browser console for player errors
- Use `showPlayerLogs=1` query param for hls.js logs
- Enable `showMetrics=1` to see playback stats
