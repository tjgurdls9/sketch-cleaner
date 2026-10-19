# Git 작업 규칙

- 0.3.0은 사용자 지시로 AGY의 `feat/local-ai`를 병합하지 않는다. 원래 HEAD 3c34a04는 `archive/agy-local-ai-20261019`로 보관하고, main 0d6dd6c 기반 `feat/local-ai-cleanup`에서 새 검증/구현 커밋을 관리한다. 사용자가 만든 미추적 파일은 임의로 삭제하지 않는다.
- 원격은 GitHub 비공개 `sketch-cleaner`, 기본 브랜치는 `main`.
- 소스·잠금 파일·테스트·스펙·검증 기록을 커밋한다. 사진, 프로젝트, 후보, 결과, 인증 정보, node_modules와 빌드 산출물은 제외한다.
- 메인이 파일 소유권을 조율하고 커밋한다. 현재 초기 구현은 로컬 단일 통합 브랜치, 후속 변경은 `feat/<주제>`, `fix/<주제>` 브랜치와 PR로 진행한다.
- 커밋: `docs:`, `test:`, `feat:`, `fix:`, `build:`. 테스트 RED와 GREEN은 별도 체크포인트로 보존한다.
- 각 완료 단계에서 typecheck/lint/test/build와 보안 diff 검토를 수행한다. 의도된 RED 커밋은 개발 중간 체크포인트이며 배포하지 않는다.
- 강제 push, 이력 재작성, 사용자 파일 포함을 금지한다. 인증 토큰을 저장소나 로그에 기록하지 않는다.
- Windows CI 성공도 실기기 인수 통과를 뜻하지 않는다. 서명과 실제 인수 전에는 테스트 배포로 표시한다.

## 최초 비공개 업로드 기록

2026-10-19, `https://github.com/tjgurdls9/sketch-cleaner`의 비공개·쓰기 권한을 확인했다. 일반 Git 인증을 읽을 수 없어 GitHub 연결 도구로 빈 저장소를 초기화한 뒤 단계별 커밋을 순서대로 재생했다. 각 커밋의 전체 파일 트리는 로컬 Git tree SHA와 동일함을 확인했다. 본문 `Local-Checkpoint`에 원래 SHA를 남겼다. 커밋 작성 시각·ID는 새로 생성되며, 원래 이력은 로컬 `archive/local-implementation`에 보존한다.

| 로컬 체크포인트 | GitHub 체크포인트 |
|---|---|
| `3665d8d` | `1d84ac2` |
| `f193f72` | `bd99871` |
| `f9aebf8` | `e3d974e` |
| `6a0a027` | `cab800b` |
| `e839efe` | `1b99e1c` |
| `9eeb2db` | `71e5196` |
| `a463b37` | `cbf1c30` |

로컬 초기 이력과 GitHub 재생 이력은 서로 다른 계보다. Git 인증을 통한 fetch 또는 비공개 CI 검증 자료의 `source-history.bundle`로 원격 이력을 가져온 뒤 전체 tree가 같은지 확인하고, GitHub 이력을 후속 개발의 기준으로 사용한다. bundle에는 Git 객체·ref만 포함하고 인증 설정은 포함하지 않는다. 기존 로컬 브랜치는 archive ref로 보존하며, 원래 로컬 브랜치를 그대로 push하거나 강제로 덮어쓰지 않는다. 연결 도구를 통한 후속 변경도 현재 원격 SHA를 부모로 하고, 예상 head를 검사하는 fast-forward 갱신 또는 PR을 사용한다.
