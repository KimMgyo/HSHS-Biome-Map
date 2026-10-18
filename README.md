# 흑석고 생태 지도

흑석고등학교 3D 모델을 웹에서 띄우는 디지털 트윈 생태 지도입니다. 1단계 3D 지도, 2단계 GPS 내 위치 표시, 3단계 관리자 식물 등록(위치·사진·이름·설명·모델)과 일반 사용자 열람이 들어 있습니다.

## 실행

```powershell
npm install
npm run set-password # 처음 한 번: 관리자 비밀번호 정하기
npm run dev          # http://localhost:5190 (API 서버 5192도 같은 프로세스에서 함께 켜집니다)
```

브라우저는 https 주소나 localhost에서만 GPS를 허용합니다. 학교에서 휴대폰으로 시험하려면 PC와 휴대폰을 같은 Wi-Fi에 두고 다음을 실행합니다.

```powershell
npm run dev:phone    # https://<PC의 IP>:5190 이 출력됩니다
```

포트 5173은 준교봇이 쓰는 주소라서 쓰지 않습니다. 준교봇은 PWA라서, 한 번 열었던 브라우저에서는 localhost:5173을 열면 이 지도 대신 준교봇 화면이 뜹니다.

자체 서명 인증서라 휴대폰에서 "안전하지 않음" 경고가 뜨면 고급 → 계속을 누르면 됩니다.

## 배포

운영 주소는 https://hsbiomap.xenv.cc 입니다. 3단계부터는 비밀번호 확인과 사진 저장을 맡는 서버가 필요해서, 정적 호스팅(GitHub Pages 등)만으로는 식물 기능이 동작하지 않습니다.

### Docker (Dokploy)

저장소의 `Dockerfile`이 사이트를 빌드하고 API 서버와 함께 포트 3000으로 실행합니다. Dokploy에는 다음처럼 설정되어 있습니다.

| 항목 | 값 |
| --- | --- |
| 빌드 | Dockerfile, `main` 브랜치 |
| 환경 변수 | `BIOMEMAP_ADMIN_PASSWORD` (관리자 비밀번호, 바꾸고 다시 배포하면 비밀번호가 바뀌고 모두 로그아웃), `TRUST_PROXY=1` (Cloudflare가 넘겨준 방문자 IP로 로그인 시도 제한) |
| 볼륨 | `/app/data` (비밀번호 해시, 식물 목록, 사진. 컨테이너를 새로 만들어도 남습니다) |
| 도메인 | `hsbiomap.xenv.cc` → 컨테이너 포트 3000, Dokploy에서는 https 끔 |

요청 경로는 Cloudflare Tunnel → Nginx Proxy Manager(192.168.10.15, http) → Dokploy Traefik(10.10.20.100:80) → 컨테이너입니다. https 인증서는 Cloudflare가 맡습니다.

### Node로 직접 실행

Node.js 20 이상이 있는 컴퓨터에서 다음을 실행합니다.

```powershell
npm install
npm run build
npm run set-password
npm start            # 사이트 + API, 0.0.0.0:5191 (PORT, HOST 환경 변수로 바꿀 수 있음)
```

GPS는 https에서만 동작하므로 앞단에 https를 붙여야 합니다(Caddy, Nginx, Cloudflare Tunnel, Tailscale Funnel 등). 추가 npm 패키지 없이 Node 기본 모듈만 씁니다.

## 식물 등록 (3단계)

1. 오른쪽 위 자물쇠 버튼 → 관리자 비밀번호 입력. "관리자 모드" 표시와 오른쪽 아래 **식물 추가** 버튼이 나타납니다.
2. **식물 추가**를 누르면 내 GPS 위치를 찾고, 위에서 내려다보는 화면에 내 위치 반경 30 m 원을 그립니다. 원 안을 눌러 심을 곳을 고르고(원 밖을 누르면 원 가장자리로 맞춰집니다) **다음**을 누릅니다.
3. 사진(휴대폰에서는 카메라로 바로 찍거나 앨범에서 고르기), 이름, 설명을 넣고 모델(큰 나무, 중간 나무, 작은 풀)을 고르면 그 자리에 미리 보기가 나타납니다. **저장**하면 바로 지도에 심어집니다.
4. 누구나 지도 위의 초록 핀이나 식물을 누르면 사진, 이름, 설명, 등록일, 내 위치에서의 거리를 볼 수 있습니다. 관리자에게는 삭제 버튼도 보입니다.

GPS를 못 잡거나 학교 밖에 있으면 "지도에서 직접 고르기"로 위치 제한 없이 고를 수 있습니다. 반경은 `src/config.js`의 `PLANT_PLACE_RADIUS_M`에서 바꿉니다.

사진은 올리기 전에 휴대폰에서 긴 변 1600 px JPEG로 줄여서 보냅니다. 이때 사진 속 촬영 위치(EXIF) 같은 정보도 빠집니다.

### 관리자 비밀번호와 데이터

- `npm run set-password`: 비밀번호를 바꿉니다(8자 이상). 바꾸면 이미 로그인한 기기는 모두 로그아웃됩니다. `-- --generate`를 붙이면 무작위 비밀번호를 만들어 한 번 보여 줍니다.
- 비밀번호는 `data/admin.json`에 scrypt 해시로만 저장됩니다. 로그인은 12시간 유지되고, 같은 곳에서 10분 안에 5번 틀리면 10분 동안 막힙니다.
- 식물 목록은 `data/plants.json`, 사진은 `data/uploads/`에 저장됩니다. `data/` 폴더는 git에서 빠져 있으니 이 폴더를 따로 백업하세요.

### 식물 모델 고치기

모델 원본은 `assets/blender/plants_lowpoly.blend`(미터 단위, 밑동 중심이 원점)입니다. Blender에서 고치고 저장한 뒤 다음 두 줄로 웹용 파일과 선택 화면 썸네일을 다시 만듭니다.

```powershell
$blender = "C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe"
& $blender -b --factory-startup assets/blender/plants_lowpoly.blend --python tools/blender/export_plant_glbs.py
& $blender -b --factory-startup --python tools/blender/render_plant_thumbs.py
```

`tools/blender/make_lowpoly_plants.py`는 세 모델을 처음부터 새로 만드는 스크립트라서, 손으로 고친 `.blend`를 덮어쓰지 않도록 조심하세요.

## 화면 기능

- 한 손가락 끌기로 이동, 두 손가락으로 회전과 확대/축소(마우스는 왼쪽 이동, 오른쪽 회전, 휠 확대).
- 오른쪽 아래 버튼: 2D/3D 전환, 학교 전체 보기, 내 위치.
- 내 위치를 누르면 위치 권한을 묻고, 파란 점(정확도 원, 바라보는 방향 부채꼴 포함)을 표시하고 따라갑니다. 지도를 직접 움직이면 따라가기가 꺼집니다.
- 오른쪽 위 나침반을 누르면 북쪽이 위로 오도록 돌아갑니다.

## GPS와 모델 좌표 맞추기

`public/georef.json`이 Blender 좌표와 위도/경도를 잇습니다.

| 필드 | 뜻 |
| --- | --- |
| originLat, originLon | Blender 원점(0, 0)의 실제 위치 |
| metersPerUnit | Blender 1단위가 실제 몇 m인지 (현재 0.538) |
| rotationDeg | 모델 북쪽(+Y)이 진북에서 시계 방향으로 돌아간 각도 |
| groundHeight | 지면 높이(Blender Z), 바닥 메시가 없을 때 쓰는 값 |

현재 값은 최신 위성사진의 건물·운동장 모서리 6곳으로 맞춘 것이고 잔차는 약 0.4 m입니다. 조사 근거는 [docs/site-research.md](docs/site-research.md)에 있습니다.

현장에서 다시 맞추려면 `?calibrate`를 붙여 접속합니다(예: `https://…/?calibrate`). 알아보기 쉬운 지점에 서서 지도에서 그 지점을 찍고 GPS를 기록해 지점을 추가하고, 멀리 떨어진 지점 2곳 이상을 모은 뒤 보정 적용을 누릅니다. 결과는 그 기기에만 저장되므로 georef.json 받기로 파일을 내려받아 `public/georef.json`을 바꿔야 모두에게 반영됩니다.

## 3D 모델 갱신

Blender에서 `흑석고.blend`를 고친 뒤 다음 중 하나로 `public/models/heukseok.glb`를 다시 만듭니다.

```powershell
# 터미널에서
& "C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe" -b "D:\Users\G433m\Documents\카카오톡 받은 파일\흑석고.blend" --python tools/blender/export_school_glb.py -- public/models/heukseok.glb
```

또는 Blender를 켠 상태에서 공식 Blender MCP의 `execute_blender_code` 도구로 `tools/blender/export_school_glb.py` 내용을 실행합니다. 모델을 옮기거나 크기를 바꾸면 georef.json도 다시 맞춰야 합니다.

지면으로 취급하는 오브젝트 이름(`g`, `road.002`, `send`, `Plane`)은 `src/config.js`에 있습니다. 위치 점은 이 바닥 위에 놓이고 지붕 위에는 올라가지 않습니다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `src/viewer.js` | three.js 장면, 조명, 카메라 조작, 2D/3D 전환 |
| `src/geo.js` | 위도/경도 ↔ 모델 좌표 변환, 보정 계산(최소제곱) |
| `src/location.js` | GPS 추적, 나침반 방향, 위치 표시 |
| `src/calibration.js` | `?calibrate` 현장 보정 패널 |
| `src/plants.js` | 식물 모델과 핀을 지도에 배치, 탭 감지 |
| `src/plant-editor.js` | 식물 추가 흐름(위치 고르기, 입력 양식, 사진 줄이기, 저장) |
| `src/plant-card.js` | 식물 정보 카드, 관리자 삭제 |
| `src/admin.js`, `src/api.js` | 관리자 로그인 창, 서버 API 호출 |
| `src/main.js` | 화면 버튼과 상태 표시 연결 |
| `server/index.js` | API(식물 목록·추가·삭제, 로그인), 사진 제공, `--static`이면 사이트도 제공 |
| `server/auth.js`, `server/set-password.js` | 비밀번호 해시, 로그인 토큰, 시도 제한, 비밀번호 설정 |
| `scripts/dev.mjs` | API 서버와 Vite를 한 프로세스로 실행 |
| `tools/blender/export_school_glb.py` | 학교 Blender → GLB 내보내기 |
| `tools/blender/export_plant_glbs.py`, `render_plant_thumbs.py` | 식물 GLB 내보내기, 썸네일 렌더 |

## Blender MCP

공식 Blender Lab MCP(v1.0.3)가 설치되어 있습니다.

- 서버: `C:\blender_mcp` (Codex 설정의 `mcp_servers.blender`)
- Blender 애드온: Blender 5.2 사용자 확장 `mcp`, 자동 시작, 포트 9877
- 기존 커뮤니티 BlenderMCP 애드온이 9876 포트를 쓰고 있어서 공식 애드온은 9877을 씁니다.
