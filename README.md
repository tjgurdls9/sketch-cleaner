# Sketch Cleaner · 의류 도해 정리

Windows 11 x64용 의류 작업지 편집 앱입니다. 지울 곳을 빨강으로, 남길 곳을 파랑으로 지정하고 선택한 곳에만 편집을 적용합니다. 원본은 별도로 보존합니다.

사용자는 Node, Python, 명령어, API 키를 준비하지 않습니다. 별도 AI 요금이나 서버는 없습니다. ChatGPT Plus는 사용자가 공식 웹사이트에서 직접 사용하며, 앱은 파일 준비와 결과 검수를 돕습니다. 사진을 직접 첨부할 때 외부 서버에서 처리됩니다.

현재는 **실무 인수 전 테스트 버전**입니다. 설치 파일 서명, 실제 Windows 장비, 업무 사진과 Plus 계정에서 확인해야 하는 항목은 [인수 기록](docs/ACCEPTANCE.md)에 따로 기록합니다.

- [한 장 사용 안내](docs/USER_GUIDE.ko.md)
- [구현 기준](IMPLEMENTATION_SPEC.md)
- [페이즈·담당·검토 계획](plans/implementation.md)
- [Git 작업 규칙](docs/GIT_PROTOCOL.md)
- [검증·보안 기록](docs/ACCEPTANCE.md)

## 개발자용

Node 24와 npm을 사용하는 Electron + TypeScript + Canvas 2D 앱입니다. 최종 사용자에게 이 절차를 요구하지 않습니다.

```sh
npm ci
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

개발 의존성은 lockfile로 고정합니다. 개인 사진과 프로젝트를 저장소에 넣지 않습니다. 앱은 원격 분석·업로드·ChatGPT 자동 로그인·비공개 API를 사용하지 않습니다.
