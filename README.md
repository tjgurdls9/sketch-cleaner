# Sketch Cleaner · 의류 도해 정리

Windows 11 x64용 의류 작업지 정리 앱입니다. **사진 선택 → 원본 확인 → 자동 정리 버튼 → 직접 수정 → 확인·저장** 순서로 사용합니다. 원본은 별도로 보존합니다.

0.3.0은 CPU에서 실행하는 글씨 감지 AI 모델을 포함합니다. 자동 정리 버튼을 누르면 글씨와 주변 표시를 보수적으로 정리합니다. 도해 내부·겹친 표시·불확실한 영역은 남겨 직접 수정하도록 합니다. 새 사진을 열거나 작업을 재개할 때 자동으로 이미지를 바꾸지 않습니다. 모델 출처·고정 해시·라이선스는 [모델 고지](models/NOTICE)에 기록합니다. 실제 업무 사진 품질은 인수시험 전입니다.

사용자는 Node, Python, 명령어, API 키를 준비하지 않습니다. 별도 AI 요금이나 서버는 없습니다. ChatGPT Plus는 사용자가 공식 웹사이트에서 직접 사용하며, 앱은 파일 준비와 결과 검수를 돕습니다. 사진을 직접 첨부할 때 외부 서버에서 처리됩니다.

현재는 **실무 인수 전 테스트 버전**입니다. 설치 파일 서명, 실제 Windows 장비, 업무 사진과 Plus 계정에서 확인해야 하는 항목은 [인수 기록](docs/ACCEPTANCE.md)에 따로 기록합니다.

- [한 장 사용 안내](docs/USER_GUIDE.ko.md)
- [구현 기준](IMPLEMENTATION_SPEC.md)
- [페이즈·담당·검토 계획](plans/implementation.md)
- [Git 작업 규칙](docs/GIT_PROTOCOL.md)
- [검증·보안 기록](docs/ACCEPTANCE.md)

## Windows 테스트 설치

전달받은 ZIP의 압축을 풀고 `SketchCleaner-0.3.0-Setup.exe`를 실행한 뒤 시작 메뉴의 **Sketch Cleaner**를 엽니다. GitHub 사용법은 필요하지 않습니다. GitHub에서는 Actions의 검증된 `Windows test build` 실행 하단에 있는 `SketchCleaner-Windows-x64-TEST-unsigned` 파일로 제공합니다. Artifact 보관 기간은 14일입니다. 서명이 없는 테스트 설치 파일이므로 Windows 경고가 표시될 수 있습니다.

## 개발자용

Node 24와 npm을 사용하는 Electron + TypeScript + Canvas 2D 앱입니다. 최종 사용자에게 이 절차를 요구하지 않습니다.

```sh
npm ci
npm run prepare:model
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm start
```

Windows x64에서 설치 프로그램 생성:

```sh
npm run make -- --platform win32 --arch x64
```

Windows CI는 검사 후 서명 없는 테스트 설치 파일을 artifact로 보관합니다. CI 빌드 성공은 실제 Windows 설치·사용성·사진 품질 인수 통과와 다릅니다. 업데이트는 수동 설치 파일 교체이며 앱에는 프로젝트 자동 삭제나 자동 업데이트 기능이 없습니다.

개발 단계에서만 고정 모델을 내려받아 SHA-256을 확인합니다. 설치 파일에는 모델과 CPU 런타임이 포함되며, 사용 중 다운로드나 사진 전송은 없습니다.

개발 의존성은 lockfile로 고정합니다. 개인 사진과 프로젝트를 저장소에 넣지 않습니다. 앱은 원격 분석·업로드·ChatGPT 자동 로그인·비공개 API를 사용하지 않습니다.
