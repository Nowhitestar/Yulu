# Changelog

All notable changes to Yulu are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.23.0-rc.10](https://github.com/Nowhitestar/Yulu/compare/v0.23.0-rc.9...v0.23.0-rc.10) (2026-09-04)


### Bug Fixes

* **app:** ignore stale launchd override residue ([#170](https://github.com/Nowhitestar/Yulu/issues/170)) ([#178](https://github.com/Nowhitestar/Yulu/issues/178)) ([c2491f8](https://github.com/Nowhitestar/Yulu/commit/c2491f8d3596ac9d1e7860dce2f59332a257b6a4))
* **release:** bind RC10 acceptance gates ([#180](https://github.com/Nowhitestar/Yulu/issues/180)) ([cc6eb06](https://github.com/Nowhitestar/Yulu/commit/cc6eb0662301d42e153a3273d547eefa8554f695)), closes [#170](https://github.com/Nowhitestar/Yulu/issues/170)

## [0.23.0-rc.9](https://github.com/Nowhitestar/Yulu/compare/v0.23.0-rc.8...v0.23.0-rc.9) (2026-09-04)


### Bug Fixes

* **app:** bootstrap fresh Host configuration ([#170](https://github.com/Nowhitestar/Yulu/issues/170)) ([c57c0f4](https://github.com/Nowhitestar/Yulu/commit/c57c0f486846c2b7409269f18e089cf6126169c5))

## [0.23.0-rc.8](https://github.com/Nowhitestar/Yulu/compare/v0.23.0-rc.7...v0.23.0-rc.8) (2026-09-01)


### Bug Fixes

* **app:** register fresh-install background services ([#170](https://github.com/Nowhitestar/Yulu/issues/170)) ([fea5faf](https://github.com/Nowhitestar/Yulu/commit/fea5faf173ea88da8dd9bd9300b45c3b288eaa09))

## [0.23.0-rc.7](https://github.com/Nowhitestar/Yulu/compare/v0.23.0-rc.6...v0.23.0-rc.7) (2026-09-01)


### Bug Fixes

* accept inert macOS pip3 shim ([#170](https://github.com/Nowhitestar/Yulu/issues/170)) ([34471cf](https://github.com/Nowhitestar/Yulu/commit/34471cfd41468d30d349f353aae22ba7485c4c2c))

## [0.23.0-rc.6](https://github.com/Nowhitestar/Yulu/compare/v0.23.0-rc.5...v0.23.0-rc.6) (2026-09-01)


### Bug Fixes

* accept inert macOS Python shim ([#170](https://github.com/Nowhitestar/Yulu/issues/170)) ([67cf18e](https://github.com/Nowhitestar/Yulu/commit/67cf18e242ff514fa963f4b86006cb9e17ce0d6e))

## [0.23.0-rc.5](https://github.com/Nowhitestar/Yulu/compare/v0.23.0-rc.4...v0.23.0-rc.5) (2026-08-31)


### Bug Fixes

* accept GitHub release asset provenance ([#170](https://github.com/Nowhitestar/Yulu/issues/170)) ([0f61001](https://github.com/Nowhitestar/Yulu/commit/0f61001f4e49a9894c74db0668dc2016c4795964))
* validate browser provenance entries ([#170](https://github.com/Nowhitestar/Yulu/issues/170)) ([1402e2e](https://github.com/Nowhitestar/Yulu/commit/1402e2eb625e142c819e103318ff742e5026c9fd))

## [0.23.0-rc.4](https://github.com/Nowhitestar/Yulu/compare/v0.23.0-rc.3...v0.23.0-rc.4) (2026-08-31)


### ⚠ BREAKING CHANGES

* voicemail is removed; every recording is a meeting. The Cmd+Shift+V mic-only hotkey, the voicemail-todos prompt, and the voicemails/ directory no longer exist. Existing voicemail_* recordings are renamed voicemail_* → Memo_* by an automatic migration on upgrade.

### Features

* **09-01:** block updates during active recordings ([5d42617](https://github.com/Nowhitestar/Yulu/commit/5d42617201983fdea2e211d113117d3614c679ef))
* **09-01:** pin stable bootstrap to release assets ([2689f2c](https://github.com/Nowhitestar/Yulu/commit/2689f2ce2bc6c0b5c6eccff90de3074fdda50905))
* **09-02:** gate release binaries on macOS 13 metadata ([097b029](https://github.com/Nowhitestar/Yulu/commit/097b029ba371b7d1c47532f94a26870f0c3076ba))
* **09-02:** target shipped Swift builds at macOS 13 ([17b44d1](https://github.com/Nowhitestar/Yulu/commit/17b44d1d73e50e6aefd57e6dd87ce270e073ce39))
* **09-03:** make dependency setup core-first ([4805d34](https://github.com/Nowhitestar/Yulu/commit/4805d34a5c44a904632f7d867da43c043156073c))
* **09-03:** make optional activation non-blocking ([daf09d1](https://github.com/Nowhitestar/Yulu/commit/daf09d142518d279b1a2e459ed4a2ab582314962))
* **10-01:** add independent intelligence selections ([7244fe9](https://github.com/Nowhitestar/Yulu/commit/7244fe958956deea7d356ab02b5709bed2f92109))
* **10-01:** expose conversation identity status ([f853191](https://github.com/Nowhitestar/Yulu/commit/f853191f237ddcec179ef8578da5795d9ff7aae2))
* **10-01:** migrate legacy conversation identity ([97561ab](https://github.com/Nowhitestar/Yulu/commit/97561ab1455674e78daccc2f781f966835d28f1f))
* **10-01:** pause summary provider failures ([1a9529d](https://github.com/Nowhitestar/Yulu/commit/1a9529dd6db26dfbf34c578ec7d3dd9280fd6bdc))
* **10-01:** persist conversation pause state ([2fee8dd](https://github.com/Nowhitestar/Yulu/commit/2fee8dd280710367318199de12c705bb16cfe63a))
* **10-01:** pin conversation identity at creation ([d95ab65](https://github.com/Nowhitestar/Yulu/commit/d95ab6541bdf617a3672a7872848afc06b5611ed))
* **10-01:** pin summary identity in durable tasks ([2825762](https://github.com/Nowhitestar/Yulu/commit/282576202efef746c9a9eddf183b231e8e7364c2))
* **activation:** complete core activation journey ([#153](https://github.com/Nowhitestar/Yulu/issues/153)) ([a4e6ee3](https://github.com/Nowhitestar/Yulu/commit/a4e6ee3368d629680e561528e79a89992c68c78b))
* add agent runtime diagnostics ([#143](https://github.com/Nowhitestar/Yulu/issues/143)) ([84ef0df](https://github.com/Nowhitestar/Yulu/commit/84ef0dfe3d95dfd23279cd9afcd07c8cf8b105ac))
* add AI connector integrations ([f200a37](https://github.com/Nowhitestar/Yulu/commit/f200a37e59d09b22f1c91d205ad53baa94f6144d))
* add CLIProxyAPI gateway connection ([#137](https://github.com/Nowhitestar/Yulu/issues/137)) ([e421f79](https://github.com/Nowhitestar/Yulu/commit/e421f79fc783fbd32958f038584f895103eb2f66))
* add conversation-only agent connections ([#138](https://github.com/Nowhitestar/Yulu/issues/138)) ([b17d306](https://github.com/Nowhitestar/Yulu/commit/b17d306020c8c973452b91ef3a6a68486f9f1740))
* add resumable activation entry ([#128](https://github.com/Nowhitestar/Yulu/issues/128)) ([9c2a4ad](https://github.com/Nowhitestar/Yulu/commit/9c2a4ad89b78940ed27ed3ea78fcf61888eb1ab9))
* add tool-free Claude summaries ([#140](https://github.com/Nowhitestar/Yulu/issues/140)) ([a34f540](https://github.com/Nowhitestar/Yulu/commit/a34f54046c8ed2abda94646b02d4be9cac289ecc))
* add tool-free Codex summaries ([#139](https://github.com/Nowhitestar/Yulu/issues/139)) ([79ded45](https://github.com/Nowhitestar/Yulu/commit/79ded45044bbe230b2f004607b496a82251f732e))
* add voice input workflow and streamline agent console ([f20c585](https://github.com/Nowhitestar/Yulu/commit/f20c585d31d32b8365f4b504e8afa09f3f14f46a))
* add Yulu HTTP MCP server ([2e6f450](https://github.com/Nowhitestar/Yulu/commit/2e6f450cdfb6947f940952738a68027243b969b1))
* **agent-connections:** guide native runtime setup ([#152](https://github.com/Nowhitestar/Yulu/issues/152)) ([3f2f67f](https://github.com/Nowhitestar/Yulu/commit/3f2f67f81de216e7c98cb9870f0d93f1ee7a3d2c))
* **agent-console:** ship agent-native workspace ([0420ef3](https://github.com/Nowhitestar/Yulu/commit/0420ef328707f56435ca433b84835e22da35665b))
* agent-native provisioning & cross-platform foundation (v0.5 milestone) ([#37](https://github.com/Nowhitestar/Yulu/issues/37)) ([b18164d](https://github.com/Nowhitestar/Yulu/commit/b18164d99ba1b323b826277cb42202497aebb972))
* **agent:** delegate recording pipeline to Hermes ([#87](https://github.com/Nowhitestar/Yulu/issues/87)) ([62e6411](https://github.com/Nowhitestar/Yulu/commit/62e64114ec48e8471c70df1c4e616b8a7e3b17b1))
* align v0.23.0 release guidance ([#169](https://github.com/Nowhitestar/Yulu/issues/169)) ([d99850c](https://github.com/Nowhitestar/Yulu/commit/d99850c6d67aab6d07f3602a6d0d1f4c83921668))
* **app:** add visible Yulu shell ([#159](https://github.com/Nowhitestar/Yulu/issues/159)) ([19dd4be](https://github.com/Nowhitestar/Yulu/commit/19dd4be7cb3361afcef1538f6c604c8bd25380f8))
* **ask:** dispatch pinned cited conversations ([4b5fe06](https://github.com/Nowhitestar/Yulu/commit/4b5fe0670e450c8396cb6a38c04edb6ec0d76fdd))
* **audio:** decouple transcription engines from Agents ([c0cffe6](https://github.com/Nowhitestar/Yulu/commit/c0cffe62361b4021d85dec19838ef108aa01a572))
* build shared Agent Connection Center contract ([#134](https://github.com/Nowhitestar/Yulu/issues/134)) ([8c02011](https://github.com/Nowhitestar/Yulu/commit/8c020110f7b023d65fff2632a88f35633d56c81c))
* **calendar:** adopt Agent Calendar Connector ([#156](https://github.com/Nowhitestar/Yulu/issues/156)) ([f28459b](https://github.com/Nowhitestar/Yulu/commit/f28459b25a4e2a5f3a0e19c77010f3c4be7758f9))
* **calendar:** adopt proven calendar sources ([#155](https://github.com/Nowhitestar/Yulu/issues/155)) ([dc4f05c](https://github.com/Nowhitestar/Yulu/commit/dc4f05c5437e260d15305ffadf297134c0c11479))
* **captions:** redesign realtime subtitles and translation ([5dee237](https://github.com/Nowhitestar/Yulu/commit/5dee237d95b4f8065588b3f56c2386c35df78e2a))
* complete guided core activation ([#131](https://github.com/Nowhitestar/Yulu/issues/131)) ([b4f139a](https://github.com/Nowhitestar/Yulu/commit/b4f139ade252efaa5a7b64545d0f5cad5794ad92))
* **config:** add transcription.realtime_enabled (no daemon restart) ([5a18900](https://github.com/Nowhitestar/Yulu/commit/5a18900f78b3c7390c126675b65457ac65022e62))
* **config:** transcription.diarization.* block in config.example.json ([3db009a](https://github.com/Nowhitestar/Yulu/commit/3db009a738d292fe00a948192ecbda38814d2948))
* connect Claude pinned conversations ([#136](https://github.com/Nowhitestar/Yulu/issues/136)) ([32d68e1](https://github.com/Nowhitestar/Yulu/commit/32d68e1875b04b3450917fc2dd96b47778fc5614))
* connect Codex pinned conversations ([#135](https://github.com/Nowhitestar/Yulu/issues/135)) ([3fcb3c8](https://github.com/Nowhitestar/Yulu/commit/3fcb3c8b4ff50865e1dcd9f3391a670719f9b5ab))
* **console:** localize pinned provider recovery ([9897da0](https://github.com/Nowhitestar/Yulu/commit/9897da0f73060d04bb1ae0b5ceee34e0d36e1279))
* **console:** show pinned sources and paused recovery ([87b4a5b](https://github.com/Nowhitestar/Yulu/commit/87b4a5b32246ee546af79cc2792aad27c1c5be89))
* **diarize:** calendar-attendee prior resolution in transcribe.py ([a0c9cd9](https://github.com/Nowhitestar/Yulu/commit/a0c9cd98125e324b880afc3c8a82e0c16636adb2))
* **diarize:** config-selected diarize backend construction held off the ASR dict ([d2f3dd5](https://github.com/Nowhitestar/Yulu/commit/d2f3dd5aafc52f11943996f976686d8e29a73f73))
* **diarize:** daemon DIARIZE RPC + request_diarize client ([7c31b3e](https://github.com/Nowhitestar/Yulu/commit/7c31b3eda16b8cbaa6f71187973c04fa571ff4d8))
* **diarize:** pure N-speaker merge core + .speakers.json sidecar ([3c0f067](https://github.com/Nowhitestar/Yulu/commit/3c0f06770594487cdb7f4f32b7a8e8a4d90c7383))
* **diarize:** SherpaDiarizeBackend + DiarizeBackend protocol + model resolution ([681c48c](https://github.com/Nowhitestar/Yulu/commit/681c48c5459c388cd7b8bf6b18cebe9ffd0c5a40))
* **diarize:** speaker-count strategy — calendar prior + reconcile (over-split fix) ([73a91ab](https://github.com/Nowhitestar/Yulu/commit/73a91ab5f364172604ac180f53633dc8f5e41006))
* **diarize:** tri-state yulu-managed probe_diarization() folded into doctor ([33f5f6e](https://github.com/Nowhitestar/Yulu/commit/33f5f6e0b563dd7799c751782b1037baa38a8d3b))
* **diarize:** wire ASR-&gt;diarize-&gt;merge into transcribe.py pipeline ([1347e1d](https://github.com/Nowhitestar/Yulu/commit/1347e1daef7b3d903e266d17ea132952ff98021a))
* **doctor:** check_yulu_ui — dist artifacts + plist + /healthz + log ([a3872fa](https://github.com/Nowhitestar/Yulu/commit/a3872fabb5723818e906e71167ba3ccb08dae992))
* **eval:** torch-free DER/WDER/SER harness + constructed-corpus + RTTM + UI-copy ([92b9049](https://github.com/Nowhitestar/Yulu/commit/92b9049de22fdad4598fd8bf8c0d93ae4bd0fac8))
* harden phase14 settings and diarization readiness ([950b22c](https://github.com/Nowhitestar/Yulu/commit/950b22c24add42b02bcb0703f4cdbacca1abd7f6))
* harden pinned agent work lifecycle ([#141](https://github.com/Nowhitestar/Yulu/issues/141)) ([6aa7630](https://github.com/Nowhitestar/Yulu/commit/6aa7630d451b6d98b680abc57204b19a734ea77b))
* harden RC4 migration and DMG acceptance ([#168](https://github.com/Nowhitestar/Yulu/issues/168)) ([d429e68](https://github.com/Nowhitestar/Yulu/commit/d429e684e7b58091ae8e92a083e9d24b37ae55b1))
* **onboarding:** add versioned onboarding home ([#150](https://github.com/Nowhitestar/Yulu/issues/150)) ([49334ed](https://github.com/Nowhitestar/Yulu/commit/49334ed3a0137b4363b37bcc41658d8db491a361))
* **onboarding:** adopt proven conversations ([#154](https://github.com/Nowhitestar/Yulu/issues/154)) ([a51537e](https://github.com/Nowhitestar/Yulu/commit/a51537e8f4bee4effebeca825f6ee578f3bb94b6))
* **onboarding:** adopt proven Sharing ([#157](https://github.com/Nowhitestar/Yulu/issues/157)) ([a750903](https://github.com/Nowhitestar/Yulu/commit/a7509033c3549d7bee2a0b3081a027cb57c37f1d))
* **onboarding:** migrate exact existing outcomes ([#158](https://github.com/Nowhitestar/Yulu/issues/158)) ([a166ee7](https://github.com/Nowhitestar/Yulu/commit/a166ee78025276fb87d2c287125e6f50cdaa4a7d))
* **prompts:** {{speaker_transcript}}/{{speaker_list}} summary prompt vars ([7ee94d5](https://github.com/Nowhitestar/Yulu/commit/7ee94d56c1c8a689b9d8dd7df9806c581ed95384))
* prove summary provider readiness ([#130](https://github.com/Nowhitestar/Yulu/issues/130)) ([62ad167](https://github.com/Nowhitestar/Yulu/commit/62ad167317cd515b6fbcdf1db8c20e6080ca4f54))
* **providers:** complete shared connection readiness copy ([0551812](https://github.com/Nowhitestar/Yulu/commit/05518129dc9cc817454c79cabfd7bb9f1eff0c5f))
* **providers:** expose independent xAI readiness probes ([ba3ff11](https://github.com/Nowhitestar/Yulu/commit/ba3ff113422ab5bb1a00faccd5c7150b085d52f4))
* **providers:** mark real readiness as successful ([5c018cf](https://github.com/Nowhitestar/Yulu/commit/5c018cfd2b6c9a7c49d77e9c37509be864a5e0a7))
* **provision:** co-locate sherpa-onnx on the daemon interpreter (cp314 verified) + engine-aware models check ([44c04d4](https://github.com/Nowhitestar/Yulu/commit/44c04d4bc0c37aa0ce2e946e09850b91846c30b6))
* **provision:** idempotent diarization ONNX model provisioning in the models step ([b1d1032](https://github.com/Nowhitestar/Yulu/commit/b1d10320f88828b994d3531e1109a4afce3ba5b6))
* **reader:** expose pinned summary recovery ([00886cd](https://github.com/Nowhitestar/Yulu/commit/00886cd0ce204329214a46db4ce06960e4480061))
* **reader:** state pinned provider pause recovery ([7be35af](https://github.com/Nowhitestar/Yulu/commit/7be35af95fc1b288ee77b3bcb3a6af87ce2d8511))
* recognize core activation evidence ([#127](https://github.com/Nowhitestar/Yulu/issues/127)) ([2b7227e](https://github.com/Nowhitestar/Yulu/commit/2b7227ec8ed8d4b356f881e727495e097720e4e2))
* **recordings:** keep capture and transcription continuous ([#97](https://github.com/Nowhitestar/Yulu/issues/97)) ([f1fabf9](https://github.com/Nowhitestar/Yulu/commit/f1fabf9a829f194f7810f64142d746d1e451a2bb))
* **recordings:** regenerate summaries through durable tasks ([09fe1b2](https://github.com/Nowhitestar/Yulu/commit/09fe1b2223defe41a5acbde6dec92051d01c2048))
* **recordings:** restore atomic meeting actions ([#95](https://github.com/Nowhitestar/Yulu/issues/95)) ([1d783fa](https://github.com/Nowhitestar/Yulu/commit/1d783fad64598fc332c5f720be2725db888aa749))
* recover blocked activation work ([#132](https://github.com/Nowhitestar/Yulu/issues/132)) ([ebb8f58](https://github.com/Nowhitestar/Yulu/commit/ebb8f581968e5f709120db096639391e693c699d))
* **release:** publish the app only as a verified DMG ([#167](https://github.com/Nowhitestar/Yulu/issues/167)) ([c6098a9](https://github.com/Nowhitestar/Yulu/commit/c6098a954f09855b43f60e3de5d3fe6491895822))
* remove voicemail entirely, unify into meeting ([#46](https://github.com/Nowhitestar/Yulu/issues/46)) ([5030f4c](https://github.com/Nowhitestar/Yulu/commit/5030f4c75b7cdfa05f9ec8b87ce05c716b14236e))
* require explicit cloud transcription readiness ([#129](https://github.com/Nowhitestar/Yulu/issues/129)) ([2368742](https://github.com/Nowhitestar/Yulu/commit/23687429f48e629e66dd9f77bc08237582cf99e8))
* **runtime:** expand standard application data paths ([#161](https://github.com/Nowhitestar/Yulu/issues/161)) ([2100096](https://github.com/Nowhitestar/Yulu/commit/2100096c52abdc18843c179cd8a936b5c5f91786))
* **runtime:** migrate Capture and Python paths ([#163](https://github.com/Nowhitestar/Yulu/issues/163)) ([69d3f9a](https://github.com/Nowhitestar/Yulu/commit/69d3f9af12682ccc0509af461845a76f829d117e))
* **runtime:** migrate Host durable state ([#162](https://github.com/Nowhitestar/Yulu/issues/162)) ([98846cc](https://github.com/Nowhitestar/Yulu/commit/98846cce2777dd5a637a22f565af512d55242bcc))
* **runtime:** migrate legacy state transactionally ([#165](https://github.com/Nowhitestar/Yulu/issues/165)) ([0f2381b](https://github.com/Nowhitestar/Yulu/commit/0f2381b8526ad250131be6c21e45bb73a2daa1e5))
* **runtime:** ship immutable self-contained app ([#160](https://github.com/Nowhitestar/Yulu/issues/160)) ([a2322bb](https://github.com/Nowhitestar/Yulu/commit/a2322bb7de2669c39c83719271534f49b8eb256d))
* **runtime:** take background ownership with SMAppService ([#164](https://github.com/Nowhitestar/Yulu/issues/164)) ([d9abe4a](https://github.com/Nowhitestar/Yulu/commit/d9abe4ab46719493b4d2863658bacdc78e25ba5c))
* **search:** bound conversation meeting sources ([30f43e1](https://github.com/Nowhitestar/Yulu/commit/30f43e17e3c556381d34270e929204388ee404ef))
* **sessions:** bound local conversation history ([38790f9](https://github.com/Nowhitestar/Yulu/commit/38790f95b604a64c4cc38ba11ac9d9b93a74720b))
* **sessions:** resolve conversation identity server-side ([ecd402a](https://github.com/Nowhitestar/Yulu/commit/ecd402ac9cb6895e8bc2cb56c6826cc50b781c8f))
* **settings:** 3-column MasterDetail settings UI + full section editing + app-wide i18n (P1–P4) ([#50](https://github.com/Nowhitestar/Yulu/issues/50)) ([98c6e31](https://github.com/Nowhitestar/Yulu/commit/98c6e312855a179eca0a153afa437d86bd305d91))
* **settings:** add resource provisioning actions ([886d2b1](https://github.com/Nowhitestar/Yulu/commit/886d2b1d9f83354363cb2c492319dd23bd0765e3))
* **settings:** add shared AI Providers readiness ([80bdc03](https://github.com/Nowhitestar/Yulu/commit/80bdc037b0a4edbe71b66db9996c0783e95bba26))
* **settings:** auto-detect gog accounts ([0930499](https://github.com/Nowhitestar/Yulu/commit/0930499959987b260f034a8f6b555f57fd78a5f8))
* **settings:** declarative registry + config-write correctness (P0) ([#49](https://github.com/Nowhitestar/Yulu/issues/49)) ([f1b53c9](https://github.com/Nowhitestar/Yulu/commit/f1b53c9333833168dbbc88fd5dbc516c9bf3b165))
* **settings:** explain missing capabilities ([38da715](https://github.com/Nowhitestar/Yulu/commit/38da7153147e6edbfa8fb805e07a6a847da1c22c))
* **settings:** realtime transcription toggle in Transcription section ([ca12535](https://github.com/Nowhitestar/Yulu/commit/ca12535f6788e70d757a7ed4c10253810ae0c9ea))
* **settings:** select watched calendars from gog ([a81d924](https://github.com/Nowhitestar/Yulu/commit/a81d924ac32c7d54c074d00fbf58da983a3660bc))
* **setup:** build + install yulu_ui (Node 20+ guard, idempotent npm ci, healthz verify) ([b0c0c4b](https://github.com/Nowhitestar/Yulu/commit/b0c0c4b2003edb093774b4d23389e12ee8ba3799))
* **setup:** seed transcription.realtime_enabled=true in default config ([b98aa45](https://github.com/Nowhitestar/Yulu/commit/b98aa45fba88e1400e6e69a8cd6d6c73630cdc72))
* **sharing:** add manual recording share actions ([#149](https://github.com/Nowhitestar/Yulu/issues/149)) ([911457c](https://github.com/Nowhitestar/Yulu/commit/911457c9d5a58371e06c1a2aa79d2dbc60b4bf8e))
* **sharing:** establish provable sharing configuration ([#148](https://github.com/Nowhitestar/Yulu/issues/148)) ([423cc9e](https://github.com/Nowhitestar/Yulu/commit/423cc9eb39643423380677f0fcb02fc2939cf31e))
* **statusagent:** menu sync to recordings + open web inbox + CI compile ([07bdc88](https://github.com/Nowhitestar/Yulu/commit/07bdc88c33d5cb1617401b9ebc5b41ea85096edf))
* **stt:** support Hermes transcription provider ([a3c7c32](https://github.com/Nowhitestar/Yulu/commit/a3c7c32210efb3f1c371e7396dd172ae6d98691e))
* **summary:** commit automatic xAI summaries ([c35ffbf](https://github.com/Nowhitestar/Yulu/commit/c35ffbf944e00b78927fb4a7dfd04c4789fe00d7))
* **summary:** pause failed xAI summaries ([70512b4](https://github.com/Nowhitestar/Yulu/commit/70512b4e1b599763a046fb1a3416cb83c88f1f2d))
* **ui:** add liquid glass redesign ([ca9bb04](https://github.com/Nowhitestar/Yulu/commit/ca9bb0444ec0615b65ac4a872e4768cd5cbe7908))
* **ui:** apply Yulu brand system and streamline workflows ([#85](https://github.com/Nowhitestar/Yulu/issues/85)) ([5a07539](https://github.com/Nowhitestar/Yulu/commit/5a07539a83506beb2e1f91f0f23bd904b3f0b23e))
* **ui:** recordings reader — markdown summary, transcript dedup, rename/tags/delete, real status ([#44](https://github.com/Nowhitestar/Yulu/issues/44)) ([8aace30](https://github.com/Nowhitestar/Yulu/commit/8aace308188569a43054234ea6380348d51e366c))
* unify agent connection onboarding ([#142](https://github.com/Nowhitestar/Yulu/issues/142)) ([48ead34](https://github.com/Nowhitestar/Yulu/commit/48ead34fe8abccee593c3e5131f3d729351d0d16))
* unify Yulu audio credentials and native interface ([#115](https://github.com/Nowhitestar/Yulu/issues/115)) ([5415429](https://github.com/Nowhitestar/Yulu/commit/5415429a708d8ae3836e35b788a652a54c70082a))
* **uninstall:** pkill yulu_ui/dist/server.js leftover Node process ([6b397f8](https://github.com/Nowhitestar/Yulu/commit/6b397f818b75fb3f889e49488839a83a9739944c))
* **update:** replace the signed app safely with Sparkle ([#166](https://github.com/Nowhitestar/Yulu/issues/166)) ([449904b](https://github.com/Nowhitestar/Yulu/commit/449904b513e720fd7c3a4cab583892a348cc5f26))
* **voicemail:** cmd_new starts realtime transcriber + promotes on stop ([c56ad35](https://github.com/Nowhitestar/Yulu/commit/c56ad353f067859c9dde5a67f3d485bcb4bc52ba))
* **voicemail:** promote realtime transcript with speaker-tag stripping ([17b258e](https://github.com/Nowhitestar/Yulu/commit/17b258ee2437707eebdc5648272d546090625465))
* **xai:** add explicit Keychain API key lifecycle ([360c209](https://github.com/Nowhitestar/Yulu/commit/360c209918928a54bee3e6ca9a8e1a0fe24fdc5d))
* **xai:** add strict stateless text client ([2d58abf](https://github.com/Nowhitestar/Yulu/commit/2d58abf6323ca6e4795e2b26656acb3b6a1d0409))
* **xai:** guide capability setup ([#151](https://github.com/Nowhitestar/Yulu/issues/151)) ([fb90a4c](https://github.com/Nowhitestar/Yulu/commit/fb90a4c1a6a5ce5225acdd698b8aef8959211c36))
* **yulu cli:** logs ui (tail ui.log) + status block (curl healthz) ([0cf437e](https://github.com/Nowhitestar/Yulu/commit/0cf437ed48f6d32370bb0f9693e7677d7e023d73))
* **yulu_ui/backend:** JobRegistry + jobs pubsub channel + paths.scriptDir ([9989155](https://github.com/Nowhitestar/Yulu/commit/998915569b3595d1999172601b12a3f6f8250b9e))
* **yulu_ui/backend:** jobRunner — transcribe spawn, summarize queue/direct ([ff86c17](https://github.com/Nowhitestar/Yulu/commit/ff86c17650821abf001a27627e9b31531e17fe1f))
* **yulu_ui/routers:** unified recordings router (merge dirs + dispatch by stem) ([616c852](https://github.com/Nowhitestar/Yulu/commit/616c8520bc372a8c25383b350b343da5649e9930))
* **yulu_ui/routers:** voicemails+meetings transcribe/summarize mutations ([9988eb8](https://github.com/Nowhitestar/Yulu/commit/9988eb88c53202f009edf1933c149644da006928))
* **yulu_ui/tokens:** adopt canonical Ayu Light + Dark palette ([324ef73](https://github.com/Nowhitestar/Yulu/commit/324ef73cbb4ee0d3e7dc695fed84f82f5a546819))
* **yulu_ui/web:** App + RootLayout + providers tree (router child routes deferred to B.11) ([747cf9f](https://github.com/Nowhitestar/Yulu/commit/747cf9fdea578cb63bc3911bbe5d0d0ff5100e39))
* **yulu_ui/web:** AudioPlayer wavesurfer.js wrapper ([2dc6141](https://github.com/Nowhitestar/Yulu/commit/2dc614179e6b83922e6ee5c141097764326493a5))
* **yulu_ui/web:** CategoryChip (summary/cleanup/voicemail) ([9c8d0ef](https://github.com/Nowhitestar/Yulu/commit/9c8d0efd17895e3177c7bc3b3ea44914b8e7175e))
* **yulu_ui/web:** CommandEditor (string[] with drag-reorder + add/remove) ([12da2fc](https://github.com/Nowhitestar/Yulu/commit/12da2fcab84aafaa1bcdb235607aa69b53c3a786))
* **yulu_ui/web:** consolidated /health page (summary + Daemons/Logs tabs) ([758d9d3](https://github.com/Nowhitestar/Yulu/commit/758d9d3f94d26bdf12dce6c468cfc86fd202f58a))
* **yulu_ui/web:** consolidated /settings page (6 sections + anchor redirects) ([7d8a5a9](https://github.com/Nowhitestar/Yulu/commit/7d8a5a9211fbcbbc94801913fcc1d46c66bcbcf8))
* **yulu_ui/web:** converge routing to /inbox + /inbox/:stem; single Recordings sidebar entry ([3ad3c30](https://github.com/Nowhitestar/Yulu/commit/3ad3c307619c6550b0dfae98dd52614a14307633))
* **yulu_ui/web:** DaemonCard (status pill + meta + actions) ([65a746e](https://github.com/Nowhitestar/Yulu/commit/65a746ebc9fa5da951241b827e09d22401ca3875))
* **yulu_ui/web:** DbStatsRow with size/rows + optional action button ([3d16d90](https://github.com/Nowhitestar/Yulu/commit/3d16d9033ce45a4bdb8f854c10d5d7f37fab6d9d))
* **yulu_ui/web:** drag-resize sidebar + master-list columns ([867bae7](https://github.com/Nowhitestar/Yulu/commit/867bae7e3729e54f6df01e453523512468fd7129))
* **yulu_ui/web:** EditableTable base (click-to-edit cells) ([0ef0312](https://github.com/Nowhitestar/Yulu/commit/0ef03125c14c4a9c5ef137fa0e895ae8edd3695b))
* **yulu_ui/web:** EditableTable bulk select + delete with confirm ([798624c](https://github.com/Nowhitestar/Yulu/commit/798624c42411879ef03179584f59fac639fa2d76))
* **yulu_ui/web:** EmptyState component ([581e5c0](https://github.com/Nowhitestar/Yulu/commit/581e5c0a2ff58f3ec60b6121e5301d635dd29611))
* **yulu_ui/web:** FilterChips multi-select chip group ([ae2f71b](https://github.com/Nowhitestar/Yulu/commit/ae2f71b7fcf7c4d44c8b46d0dd9f4cfbbb2d06b9))
* **yulu_ui/web:** GlobalSearch popover (keyword only, ⌘K, ↑↓↵esc) ([388b83c](https://github.com/Nowhitestar/Yulu/commit/388b83c4a43218468defe6308025acbfc42f9132))
* **yulu_ui/web:** Glossary page (EditableTable + add + bulk delete) ([8c83b78](https://github.com/Nowhitestar/Yulu/commit/8c83b787f5046cdc53871c66ab31aaa737613693))
* **yulu_ui/web:** Health/Daemons page (grid of 8 cards + 5s polling) ([c2114fd](https://github.com/Nowhitestar/Yulu/commit/c2114fdbca97f1d5c7aa430a1089df5fa6b46b4f))
* **yulu_ui/web:** Health/Logs page (dropdown + LogTail + pause/clear) ([2e4c180](https://github.com/Nowhitestar/Yulu/commit/2e4c1805461d8560dcb61ad532177ca4c8207166))
* **yulu_ui/web:** HotkeyCapture component ([66bbea2](https://github.com/Nowhitestar/Yulu/commit/66bbea23b7269ed79e3ece09ffdc1eed12305b20))
* **yulu_ui/web:** InboxLayout with j/k keyboard nav across list ([7b1993c](https://github.com/Nowhitestar/Yulu/commit/7b1993c9bae882def85437255f65f3890fee5c98))
* **yulu_ui/web:** InlineEditRow (6 variants: text/number/select/toggle/path/readonly) ([b257767](https://github.com/Nowhitestar/Yulu/commit/b257767bacb745502a4eb68724fca59429646327))
* **yulu_ui/web:** integrate ReprocessButtons in Voicemail + Meeting readers ([3b1712d](https://github.com/Nowhitestar/Yulu/commit/3b1712dcff96d20ed6afb8f89d543f39752b586c))
* **yulu_ui/web:** Logo component (inline SVG matching assets/logo.svg) ([6837bb5](https://github.com/Nowhitestar/Yulu/commit/6837bb51b2a12d066be7a4fc3f27d56561a4d42a))
* **yulu_ui/web:** LogTail (auto-scroll + WS-driven append + 2000-line cap) ([db0ec00](https://github.com/Nowhitestar/Yulu/commit/db0ec00d7527850a3e907f8ad33a3a7529c332d1))
* **yulu_ui/web:** MasterDetail (220px list + outlet, inline skeleton) ([7bc78df](https://github.com/Nowhitestar/Yulu/commit/7bc78dfbe5dfd69aacd3cacabf7cb72de1653528))
* **yulu_ui/web:** MeetingReader with Realtime tab ([9836f9f](https://github.com/Nowhitestar/Yulu/commit/9836f9f310481232c611936cb1bc1baa853af70f))
* **yulu_ui/web:** Meetings filters (All/Summarized/Last 30d/Has realtime) ([e6558ce](https://github.com/Nowhitestar/Yulu/commit/e6558ce3b835449b65bf1f70ad9acc6411d46b6f))
* **yulu_ui/web:** Meetings list view with WS auto-refresh + index empty ([b4ac438](https://github.com/Nowhitestar/Yulu/commit/b4ac4384d2e5f00c8d04160443878260f3c92c68))
* **yulu_ui/web:** migrate emoji to lucide-react icons ([3bb2ee5](https://github.com/Nowhitestar/Yulu/commit/3bb2ee5804181db30c1202502c68cad41f59bf57))
* **yulu_ui/web:** Pill component (5-state machine, WS-driven) ([7d2ae36](https://github.com/Nowhitestar/Yulu/commit/7d2ae36f219145de987f4be49ee4dd9acdcb3bd1))
* **yulu_ui/web:** Placeholder component for phase route stubs ([0fea2c8](https://github.com/Nowhitestar/Yulu/commit/0fea2c84925593711c7882274a06990d2c50a425))
* **yulu_ui/web:** PromptReader (form with dirty tracking + Save/Delete) ([91d3040](https://github.com/Nowhitestar/Yulu/commit/91d304020c625887907488329e23ea23d7c6e4b1))
* **yulu_ui/web:** Prompts :id reader route (edit + create mode + delete) ([6824a62](https://github.com/Nowhitestar/Yulu/commit/6824a622fff52bc35df3308da942117e4cf8f2dc))
* **yulu_ui/web:** Prompts list with filters + new prompt button + index empty ([15fd8ae](https://github.com/Nowhitestar/Yulu/commit/15fd8ae5c804c123de0520a18456353e037cddcb))
* **yulu_ui/web:** RecordingReader — merged voicemail+meeting reader ([cc29b45](https://github.com/Nowhitestar/Yulu/commit/cc29b45add732b6f99310843f75ef7b38ff5c49a))
* **yulu_ui/web:** RecordingsList — unified /inbox list ([0645db8](https://github.com/Nowhitestar/Yulu/commit/0645db8fedbb001598e53002eca249644ff3619b))
* **yulu_ui/web:** ReprocessButton (4 visual states) ([b210a41](https://github.com/Nowhitestar/Yulu/commit/b210a4175c503f2a0c231ce1f2fccab1a67f27ea))
* **yulu_ui/web:** RestartBanner with per-daemon + restart-all actions ([7ddfbdc](https://github.com/Nowhitestar/Yulu/commit/7ddfbdc107deb8e977dc9af93ba03c42fa496453))
* **yulu_ui/web:** scaffold all 13 placeholder routes + child route registration ([0a3db7f](https://github.com/Nowhitestar/Yulu/commit/0a3db7f7c69538a596d15c3862fa37911d384a84))
* **yulu_ui/web:** Search filters (type/in dropdowns + since chips) ([fb4648e](https://github.com/Nowhitestar/Yulu/commit/fb4648e3f5c4fd7037d26b1fca096178d188dc99))
* **yulu_ui/web:** Search input + URL state + debounced query ([a67caf5](https://github.com/Nowhitestar/Yulu/commit/a67caf518d5e6a0077bbe88996eae32ed7d5aab4))
* **yulu_ui/web:** Search result row → /inbox/&lt;kind&gt;/:stem cross-nav ([15015c2](https://github.com/Nowhitestar/Yulu/commit/15015c2b3be21ecdf2f3c21c9f90d8b8d2fc8448))
* **yulu_ui/web:** Search results column with [hit] snippet rendering ([9a3662f](https://github.com/Nowhitestar/Yulu/commit/9a3662f457d4b2d9a6b10e87d8ef825347790f22))
* **yulu_ui/web:** Settings/Audio page with restart banner ([a2852a0](https://github.com/Nowhitestar/Yulu/commit/a2852a08da378304b80d1cd13ea65c07a0b9fbd9))
* **yulu_ui/web:** Settings/Hotkey & UI page (HotkeyCapture + ThemeToggle) ([3433d49](https://github.com/Nowhitestar/Yulu/commit/3433d49669c47f332debd991505006fc8b98965e))
* **yulu_ui/web:** Settings/Integrations page (calendar cards + Test connection) ([edbd351](https://github.com/Nowhitestar/Yulu/commit/edbd3510ff7cc9482525c9ee36d8ebc3ab8cbc6c))
* **yulu_ui/web:** Settings/LLM page (CommandEditor + Test popover) ([9578a89](https://github.com/Nowhitestar/Yulu/commit/9578a89e8eadcd58f348da34cc8c85a4918fa0c5))
* **yulu_ui/web:** Settings/Storage page (DbStatsRow + log paths) ([a703bd4](https://github.com/Nowhitestar/Yulu/commit/a703bd4be90af594efc0a312af5c2e1cbffebbbe))
* **yulu_ui/web:** Settings/Transcription page ([eb4e574](https://github.com/Nowhitestar/Yulu/commit/eb4e5744cb17d9013b142c9d8c8b5aac62a0ac71))
* **yulu_ui/web:** SettingsPage wrapper (banner + body) ([5480caf](https://github.com/Nowhitestar/Yulu/commit/5480cafe103b291ffc1289905524656731ffdae6))
* **yulu_ui/web:** Sidebar restructure — Logo + Inbox/Knowledge + bottom Settings/Health ([f4354e8](https://github.com/Nowhitestar/Yulu/commit/f4354e85830d908caacd20ec36b6692031838f33))
* **yulu_ui/web:** Sidebar with nav + count badges + ThemeToggle ([f830c5a](https://github.com/Nowhitestar/Yulu/commit/f830c5a4c9f5d93e225acd9c9ec6a140413237c1))
* **yulu_ui/web:** TestPopover for test command/connection output ([f6122a7](https://github.com/Nowhitestar/Yulu/commit/f6122a7992dcf6585f971c5a63bdcdb9f588e536))
* **yulu_ui/web:** ThemeProvider + useTheme + localStorage persist ([dde3b85](https://github.com/Nowhitestar/Yulu/commit/dde3b85089d6a18db19024d402f10317ae3389e9))
* **yulu_ui/web:** ThemeToggle segmented control ([31318a1](https://github.com/Nowhitestar/Yulu/commit/31318a1ab932196358feadec7b7cb3e96fcf64eb))
* **yulu_ui/web:** TopBar (breadcrumb + filters slot via route handle) ([bbc66cb](https://github.com/Nowhitestar/Yulu/commit/bbc66cb3ef693f21d088522707f7187bcf2ff61a))
* **yulu_ui/web:** TopBar multi-segment breadcrumb + GlobalSearch slot + ThemeToggle ([a7b017c](https://github.com/Nowhitestar/Yulu/commit/a7b017ce1ea7829e137f82d3ba7d0b04e7213972))
* **yulu_ui/web:** TranscriptView with vocab + speaker highlight ([0c30eb4](https://github.com/Nowhitestar/Yulu/commit/0c30eb437e48241d2b3acccf11efcbd67529598c))
* **yulu_ui/web:** tRPC client with shared AppRouter type ([ff9e6f6](https://github.com/Nowhitestar/Yulu/commit/ff9e6f6454ef6edc57817e74eb5c3d42c9324a02))
* **yulu_ui/web:** useConfirm hook (window.confirm wrapper) ([b1338a9](https://github.com/Nowhitestar/Yulu/commit/b1338a9e1e386411d2eb9fdc2c393532e4f9c478))
* **yulu_ui/web:** useDaemonHealthState aggregation hook ([9cea011](https://github.com/Nowhitestar/Yulu/commit/9cea011a23c691922e2acbfaded957c353226f6b))
* **yulu_ui/web:** useDebounced hook ([4d808c2](https://github.com/Nowhitestar/Yulu/commit/4d808c211952d82c1a1dd52e2567ac0e0b69df09))
* **yulu_ui/web:** useHotkeys hook (skips editable elements) ([b3f2199](https://github.com/Nowhitestar/Yulu/commit/b3f2199a3648f89bf068cc2070c5e67a9e89e3d2))
* **yulu_ui/web:** usePersistedSize + ResizableSplit ([2774959](https://github.com/Nowhitestar/Yulu/commit/27749599a65655e607d07b03c9cd30160bf89e6f))
* **yulu_ui/web:** useSettingsRestartTracker (daemons by key, reducer-based) ([887c8c4](https://github.com/Nowhitestar/Yulu/commit/887c8c45769fb5ce90c9dc24fa565fb86729cf0c))
* **yulu_ui/web:** VoicemailReader (:stem nested route + tabs + AudioPlayer) ([ca1a85a](https://github.com/Nowhitestar/Yulu/commit/ca1a85a26bf189a99f6ae80de9619761090a8a40))
* **yulu_ui/web:** Voicemails filters (All/Summarized/Last 7d) in list column ([308f0df](https://github.com/Nowhitestar/Yulu/commit/308f0dfb43740bdb5bdaf64140424f181c3c59ad))
* **yulu_ui/web:** Voicemails list view with WS auto-refresh + index empty ([f248cad](https://github.com/Nowhitestar/Yulu/commit/f248cad1630d1c82c74f59dc4fd368ddba324796))
* **yulu_ui/web:** voicemails URL state (?seek init + ?snippet scroll-to-match) ([11d5b59](https://github.com/Nowhitestar/Yulu/commit/11d5b59588f1f34b8fada0c577b8ab694ad25f7f))
* **yulu_ui/web:** WsProvider + useWsChannel + nextBackoff ([d0f6bd0](https://github.com/Nowhitestar/Yulu/commit/d0f6bd0e1d55fb8518956ff22d37b80731ae2f4e))
* **yulu_ui:** inboxWatcher emits sidebar-counts on fs events ([337546c](https://github.com/Nowhitestar/Yulu/commit/337546c9c15e7adfa5e5d2cf258949fad931d223))
* **yulu_ui:** integrations.test router (Python detector probe) ([4656b70](https://github.com/Nowhitestar/Yulu/commit/4656b70cc9a8ccddd7f4815507e355743d888858))
* **yulu_ui:** llm.test router (spawn config.llm.command with stdin) ([a896b79](https://github.com/Nowhitestar/Yulu/commit/a896b79b11271c53769490783a5fbb48aab9815a))
* **yulu_ui:** logTailer publishes new log lines on logs WS channel ([5d85427](https://github.com/Nowhitestar/Yulu/commit/5d8542778d6a9a785143c3d873a6c4fccff4621c))
* **yulu_ui:** serveStaticFile + SPA fallback + /assets/* on Node server ([97f072a](https://github.com/Nowhitestar/Yulu/commit/97f072a9936e49d34fabfe737cfe70bc80069202))
* **yulu_ui:** system.audioDevices via system_profiler JSON ([6dbd634](https://github.com/Nowhitestar/Yulu/commit/6dbd6346491d469eb148a7fdbc9dde8d649999be))
* **yulu_ui:** system.dbStats + system.logPaths ([b0e3592](https://github.com/Nowhitestar/Yulu/commit/b0e3592dfcaefe9920a21e3f03541747bb781533))
* **yulu_ui:** system.pickFile + system.openInFinder via osascript/open ([1bd5c61](https://github.com/Nowhitestar/Yulu/commit/1bd5c6117b9d9164d2a973138f37bc330b3703f8))
* **yulu_ui:** voicemails.list/meetings.list return firstWords ([9b4c1ba](https://github.com/Nowhitestar/Yulu/commit/9b4c1ba84fb4448257c7223125495ea3400d0f7b))


### Bug Fixes

* **09-01:** support default bootstrap on macOS Bash 3.2 ([05a8429](https://github.com/Nowhitestar/Yulu/commit/05a84290fdadb4d1f8f521bca31a7d5a78caba7f))
* **10-01:** fail closed on summary mismatch ([1726616](https://github.com/Nowhitestar/Yulu/commit/17266164504b82116f14987274b377241e2edf3d))
* allow installed agent diagnostics to finish ([#143](https://github.com/Nowhitestar/Yulu/issues/143)) ([cf42929](https://github.com/Nowhitestar/Yulu/commit/cf42929cc3382c1ac977bc304b4b4859c4d8b6e4))
* allow long xAI recording summaries ([8702727](https://github.com/Nowhitestar/Yulu/commit/8702727f52e9e03288d468428a5dea0dcee29b1d))
* **artifacts:** clear stale marker after validated commit ([04f1641](https://github.com/Nowhitestar/Yulu/commit/04f1641c5e896d2c1eb61de00c7796c649b579fb))
* **artifacts:** preserve committed transcripts ([d3899ad](https://github.com/Nowhitestar/Yulu/commit/d3899ad2d8b75b420785624c18ad24407a3db56c))
* **audio:** keep dual-track capture on a continuous timeline ([73be113](https://github.com/Nowhitestar/Yulu/commit/73be113e4f87b95fc5a8f63ee701be484b5bdb50))
* **audio:** restore meeting half-duplex playback mix ([dba4723](https://github.com/Nowhitestar/Yulu/commit/dba47235a57b536b3fb605110e4b4730c4136e76))
* **audio:** self-heal stuck sys-tap so meetings start after a voicemail ([#43](https://github.com/Nowhitestar/Yulu/issues/43)) ([9aff28f](https://github.com/Nowhitestar/Yulu/commit/9aff28f20b0c4d247a587c23a7e2c86859486adc))
* **audio:** serialize recorder state ([edda3c0](https://github.com/Nowhitestar/Yulu/commit/edda3c061042eadce568f56c372d72baab2cca16))
* **ci:** align native addons with bundled Node ([#160](https://github.com/Nowhitestar/Yulu/issues/160)) ([eb48ce0](https://github.com/Nowhitestar/Yulu/commit/eb48ce0a14ae0132d1b0dd229db000a67e5bb0ee))
* **ci:** isolate bundled Host smoke media config ([#163](https://github.com/Nowhitestar/Yulu/issues/163)) ([d9ec4ec](https://github.com/Nowhitestar/Yulu/commit/d9ec4ec69f5f976d914177fadcf05a37ce70cf07))
* **ci:** run bundled Host smoke with Node deps ([#159](https://github.com/Nowhitestar/Yulu/issues/159)) ([6a7b391](https://github.com/Nowhitestar/Yulu/commit/6a7b391df072e959b30d9eb39c460716efe32b86))
* close phase 11 activation review gaps ([78fed41](https://github.com/Nowhitestar/Yulu/commit/78fed41252ed8742d34033adb62a51da2a387660))
* **console:** distinguish selected and pinned providers ([0125850](https://github.com/Nowhitestar/Yulu/commit/012585045e9097778cf6a65834da393098602892))
* **console:** localize pinned session identity ([4f01087](https://github.com/Nowhitestar/Yulu/commit/4f01087c793821912433d9c9ea6be9e808f82ba0))
* **console:** show xAI boundary on new drafts ([7113622](https://github.com/Nowhitestar/Yulu/commit/7113622c3dff71122639fe3d53cac09ad20d3696))
* **conversation:** bound evidence and pause retrieval failures ([222cef3](https://github.com/Nowhitestar/Yulu/commit/222cef38fc6d4223645a521d74a4ce1bfe402dc2))
* **conversation:** enforce pinned xAI identity ([20d0101](https://github.com/Nowhitestar/Yulu/commit/20d01018d6419cdb796237d14a07d2463dbd875b))
* **conversation:** retry persisted snapshot atomically ([cf206af](https://github.com/Nowhitestar/Yulu/commit/cf206af8383bdae4729a8edb864b272878d45f18))
* **diarize:** count-keyed pipeline cache so per-call override can't bleed into auto ([d2a6214](https://github.com/Nowhitestar/Yulu/commit/d2a6214e89ab94e7932a740b9aa6ccc68018293c))
* **diarize:** install soundfile with sherpa runtime ([5abfced](https://github.com/Nowhitestar/Yulu/commit/5abfced7e7337b8a8c70f53ff5a202efb59e6008))
* **diarize:** tighten calendar speaker priors ([9635113](https://github.com/Nowhitestar/Yulu/commit/96351132a90286d6fba6709f019721d840db9e98))
* end recording processing before sharing ([#147](https://github.com/Nowhitestar/Yulu/issues/147)) ([09e2fe0](https://github.com/Nowhitestar/Yulu/commit/09e2fe0aa51b297036a19545066e89e60ba9d199))
* enforce runtime-owned OAuth classes ([#143](https://github.com/Nowhitestar/Yulu/issues/143)) ([ab356eb](https://github.com/Nowhitestar/Yulu/commit/ab356eb8faa8c561a76a873ad888682c76c0a20f))
* harden agent runtime probes ([#143](https://github.com/Nowhitestar/Yulu/issues/143)) ([18570a5](https://github.com/Nowhitestar/Yulu/commit/18570a57b7b36bdb65c10748bcfd0cb24e8b4c3d))
* harden dual-track post processing ([6df4d62](https://github.com/Nowhitestar/Yulu/commit/6df4d628e65e7b1c73d61ea7f1e7303a75d59ae3))
* harden recording and release status fixes ([5365dbe](https://github.com/Nowhitestar/Yulu/commit/5365dbe425d96f803699ec23e9b5abd2bb296292))
* improve echo cleanup and settings refresh ([11ee3b7](https://github.com/Nowhitestar/Yulu/commit/11ee3b7e6e8feaab548e1e4058e464e72f822a40))
* **install:** add agent-native install and uninstall plans ([#61](https://github.com/Nowhitestar/Yulu/issues/61)) ([c4fb18a](https://github.com/Nowhitestar/Yulu/commit/c4fb18a64e95212a2366cdf6c4cae199daed22c5))
* **installer:** align runtime dependency checks ([#91](https://github.com/Nowhitestar/Yulu/issues/91)) ([a8a7a7d](https://github.com/Nowhitestar/Yulu/commit/a8a7a7db04d6dc427ad5575051f301c306c2f4bc))
* isolate doctor host health by runtime ([#143](https://github.com/Nowhitestar/Yulu/issues/143)) ([8a1ea45](https://github.com/Nowhitestar/Yulu/commit/8a1ea4566d5cf6264d0f5c2d956180855b93f6f5))
* keep realtime chunks out of recordings ([33f1ce5](https://github.com/Nowhitestar/Yulu/commit/33f1ce5c3a5f30247c81d07ac0515be8026760b4))
* make realtime transcription robust for arbitrarily-long recordings ([#42](https://github.com/Nowhitestar/Yulu/issues/42)) ([f05e641](https://github.com/Nowhitestar/Yulu/commit/f05e6418c4c963c526e6e494166eab49c126a4d1))
* migrate existing xAI credential source ([43eb4fe](https://github.com/Nowhitestar/Yulu/commit/43eb4feac2d10f42f41e0d7566b6e91173f69d80))
* **packaging:** validate nested capture outputs ([#159](https://github.com/Nowhitestar/Yulu/issues/159)) ([94ededb](https://github.com/Nowhitestar/Yulu/commit/94ededb0f821639e0e7183d20723ac6d99e8d974))
* play original recording audio by default ([d549fd8](https://github.com/Nowhitestar/Yulu/commit/d549fd8be221085ea22efd0e1547a34f369b5c1d))
* preserve recording permissions on upgrade ([88e46f9](https://github.com/Nowhitestar/Yulu/commit/88e46f93e5e7c53e059df653ba1c7c607f702cfd))
* prevent pkg installer postinstall hangs ([990fb14](https://github.com/Nowhitestar/Yulu/commit/990fb14acc96a3be74f3d370b80e9450df994001))
* **providers:** localize credential recovery errors ([b639f16](https://github.com/Nowhitestar/Yulu/commit/b639f16594de95ac066a781d13d90755706764f4))
* **reader:** gate summary on committed transcript ([f9c4347](https://github.com/Nowhitestar/Yulu/commit/f9c434783f167d22d4842fb8386f9aa40a97393f))
* **reader:** wrap provider recovery actions ([4fdec9c](https://github.com/Nowhitestar/Yulu/commit/4fdec9c0c1cf8154d0475fcf0869f32566c6a154))
* recognize release installs in doctor ([2bd3173](https://github.com/Nowhitestar/Yulu/commit/2bd31730252cee48737d398d36f29428dd098cff))
* **recording:** resume interrupted captures and clean playback ([501d12f](https://github.com/Nowhitestar/Yulu/commit/501d12f365b47449586a10c1ec8820ff556098a0))
* recover recording reprocess flows ([dcad5d4](https://github.com/Nowhitestar/Yulu/commit/dcad5d42d44e243a403ca128b0e0c4f02f582437))
* reinstall incomplete ui dependencies ([fe0fbcd](https://github.com/Nowhitestar/Yulu/commit/fe0fbcd4c2fd75c9fe889f14e3d76be9508ef006))
* **release:** grant tag publish attestation permissions ([0ade731](https://github.com/Nowhitestar/Yulu/commit/0ade7314d0406dc89be49722c1ed711ee6430b5b))
* remove CLIProxyAPI product integration ([#144](https://github.com/Nowhitestar/Yulu/issues/144)) ([742e6b6](https://github.com/Nowhitestar/Yulu/commit/742e6b69bb1212ea6f12414f1d4855e61e5bfb3d))
* repair 10 fresh-user-facing bugs in the v0.6.0 release ([#41](https://github.com/Nowhitestar/Yulu/issues/41)) ([53fa35c](https://github.com/Nowhitestar/Yulu/commit/53fa35cbf725cbd68805ab196379f6b3ead27e5a))
* restore exec bits on release extract; harden setup & packaging ([#31](https://github.com/Nowhitestar/Yulu/issues/31)) ([82b0ab2](https://github.com/Nowhitestar/Yulu/commit/82b0ab26ed4c893dd0e8578bd254f8ef918b4c25))
* restore explicit pipeline baseline ([#146](https://github.com/Nowhitestar/Yulu/issues/146)) ([0a5190b](https://github.com/Nowhitestar/Yulu/commit/0a5190b44204d84701acc9d33e7489bad3213dec))
* restore xAI transcription and summary recovery ([331fd99](https://github.com/Nowhitestar/Yulu/commit/331fd999abf2ca15777c0b3348e4397757f1cbcb))
* **runtime:** isolate development app smoke ([#162](https://github.com/Nowhitestar/Yulu/issues/162)) ([82079ed](https://github.com/Nowhitestar/Yulu/commit/82079ed2eb93d0d644f42a84c6df1558e34d9f34))
* **runtime:** pin Node 24 native addon provenance ([#160](https://github.com/Nowhitestar/Yulu/issues/160)) ([a26baa6](https://github.com/Nowhitestar/Yulu/commit/a26baa6848969a737942ba8199f25cf774dceda1))
* **runtime:** resolve bundled native helpers ([#160](https://github.com/Nowhitestar/Yulu/issues/160)) ([a5f1e34](https://github.com/Nowhitestar/Yulu/commit/a5f1e347232b94f3b362f5e0b78e9014950250ba))
* **search:** bound complete highlighted excerpts ([d7cfcef](https://github.com/Nowhitestar/Yulu/commit/d7cfcef59f53426b62b8affdccf288812706aa63))
* **search:** cap serialized conversation evidence ([ff6b94a](https://github.com/Nowhitestar/Yulu/commit/ff6b94a6007920a98ee8eb6392fb98075ff34c07))
* **search:** choose anchors independent of word order ([bdde201](https://github.com/Nowhitestar/Yulu/commit/bdde2016f076836bbd295e0576388bdf5c039373))
* **search:** honor isolated runtime sockets ([21c0ad7](https://github.com/Nowhitestar/Yulu/commit/21c0ad77218bc02151a68bad1a2d8d53d8bc6e19))
* **search:** include decision owner context ([dcac3bd](https://github.com/Nowhitestar/Yulu/commit/dcac3bd6a0f7387c5c1b18cbd217aaca8457a677))
* **search:** keep natural recall privacy bounded ([ca0f30f](https://github.com/Nowhitestar/Yulu/commit/ca0f30f4f7fe9b8bf453e40321271ea8ce6f7878))
* **search:** normalize natural questions for FTS ([e8a632a](https://github.com/Nowhitestar/Yulu/commit/e8a632a93a19940b0a25e86e506022c95807f302))
* **search:** require anchored natural recall ([0be021a](https://github.com/Nowhitestar/Yulu/commit/0be021a877714c4877bf66c41353c20b2fdc20f6))
* **sessions:** rebuild retries without duplicate question ([6135039](https://github.com/Nowhitestar/Yulu/commit/6135039824de4370216328d9381181f3fc9ea62d))
* **settings:** keep retired LLM fields out of search ([852d173](https://github.com/Nowhitestar/Yulu/commit/852d173cce11d2c6a297a2984a70442ede8c68bb))
* **setup:** remove retired calendar token path ([#155](https://github.com/Nowhitestar/Yulu/issues/155)) ([16f473f](https://github.com/Nowhitestar/Yulu/commit/16f473f3ae15533713b60d321687f9fe3a6dbb30))
* ship realtime recording and installer updates ([76b4b6a](https://github.com/Nowhitestar/Yulu/commit/76b4b6a77b5f66663838368c75a2e67a4cf9b379))
* stabilize meeting-detector signature; persistent record dialog ([#35](https://github.com/Nowhitestar/Yulu/issues/35)) ([61ed4a9](https://github.com/Nowhitestar/Yulu/commit/61ed4a93891b45e005c107bf3b432d2d6eae4882))
* stabilize recording and summaries ([acda808](https://github.com/Nowhitestar/Yulu/commit/acda80821c9ae0fe591e1624bce152d2d3177aa0))
* stabilize recording workflow ([0468e95](https://github.com/Nowhitestar/Yulu/commit/0468e9541b28373bddd151b71a67074daddbcd0b))
* **stt:** use calendar attendees for speaker names ([51d095e](https://github.com/Nowhitestar/Yulu/commit/51d095ed7adb4947925b060c5370c878e6e6ce14))
* **summary:** route from claimed task snapshot ([04a99f3](https://github.com/Nowhitestar/Yulu/commit/04a99f3ffcee3a13bb5aa6398c3b271b5d265ff2))
* suppress delayed dual-track playback echo ([5747b3c](https://github.com/Nowhitestar/Yulu/commit/5747b3ca5e7e0f7974d351b06a3ab4847409f80e))
* **transcription:** harden realtime and batch reliability ([#105](https://github.com/Nowhitestar/Yulu/issues/105)) ([8a0adc0](https://github.com/Nowhitestar/Yulu/commit/8a0adc06ddd1a09c787ad3cacafd06cba0ddecfd))
* **transcription:** localize provider projection ([a8fe305](https://github.com/Nowhitestar/Yulu/commit/a8fe305745356ffa4aee951eca8b42cdf2fb6082))
* **transcription:** recover realtime xAI connections ([#107](https://github.com/Nowhitestar/Yulu/issues/107)) ([0a61057](https://github.com/Nowhitestar/Yulu/commit/0a6105773d17884bbcb39d9bdd734ca5c42a64b8))
* **transcription:** reuse live transcripts and glossary for summaries ([c7e7738](https://github.com/Nowhitestar/Yulu/commit/c7e7738bede80fa13290bb124ac2db78305f83f7))
* **ui:** improve mobile responsive layouts ([c7286f5](https://github.com/Nowhitestar/Yulu/commit/c7286f55e5b9356a7a4dc1fd70721376a1c42e23))
* **ui:** keep recorder window in saving state after stop ([a98ed47](https://github.com/Nowhitestar/Yulu/commit/a98ed47f86220769a2446064015e16d8090826d9))
* **ui:** preserve settings array drafts ([f4823c9](https://github.com/Nowhitestar/Yulu/commit/f4823c9eefb3f43ac9a83e23f86383e9ddd918ff))
* **ui:** refresh vulnerable production dependencies ([012226a](https://github.com/Nowhitestar/Yulu/commit/012226a1e7ffe32c2ad74a2dbf7c4cae9e50f10c))
* **voice-chat:** honor bounded ask source limit ([2ec95c2](https://github.com/Nowhitestar/Yulu/commit/2ec95c2dcc2a5c559a5780d1e541849f21e8b958))
* **xai:** bound chunked text responses ([c9faf2c](https://github.com/Nowhitestar/Yulu/commit/c9faf2c1a6cfd61d39b75feacc3efdbd18f0c356))
* **xai:** classify realtime entitlement denial ([#151](https://github.com/Nowhitestar/Yulu/issues/151)) ([e41fb47](https://github.com/Nowhitestar/Yulu/commit/e41fb47070000762febc4b21e93d0bf08b33d214))
* **xai:** prevent implicit credential fallback ([86312bd](https://github.com/Nowhitestar/Yulu/commit/86312bd5f9c5ba88ce604aaf8c6dbedd21170d8c))
* **xai:** prove realtime setup readiness ([#151](https://github.com/Nowhitestar/Yulu/issues/151)) ([fabe29f](https://github.com/Nowhitestar/Yulu/commit/fabe29f2e0530ff8d08dbc2481ad33e48df76c18))
* **xai:** restore failed readiness guidance ([#151](https://github.com/Nowhitestar/Yulu/issues/151)) ([46f75e5](https://github.com/Nowhitestar/Yulu/commit/46f75e58c4649c9b8bf8220ff76e4ab38e8eae1e))
* **xai:** retain failed readiness history ([#151](https://github.com/Nowhitestar/Yulu/issues/151)) ([7ec5f3f](https://github.com/Nowhitestar/Yulu/commit/7ec5f3f0437853afc580f1aeb7e260cbea9abce1))
* **yulu_ui/logTailer:** survive logrotate rotation (reopen on inode change) ([fa90c6c](https://github.com/Nowhitestar/Yulu/commit/fa90c6c4191c52c70483708de974688564cc7d98))
* **yulu_ui/web:** AudioPlayer A→B→A playback regression ([4a8e79c](https://github.com/Nowhitestar/Yulu/commit/4a8e79c89e40ceee68fa1676a3e5771aaa6e5405))
* **yulu_ui/web:** clear pending reconnect timer in ensureOpen + type cleanup ([595865b](https://github.com/Nowhitestar/Yulu/commit/595865bc2a4ecd64897b035b6dfcc2b69e96f898))
* **yulu_ui:** use app.notFound for SPA fallback (matches multi-segment paths) ([83e48aa](https://github.com/Nowhitestar/Yulu/commit/83e48aab1f7cac73cdf6cc006cf910f181706716))

## [0.22.2](https://github.com/Nowhitestar/Yulu/compare/v0.22.1...v0.22.2) (2026-07-23)


### Bug Fixes

* **transcription:** recover realtime xAI connections ([#107](https://github.com/Nowhitestar/Yulu/issues/107)) ([0a61057](https://github.com/Nowhitestar/Yulu/commit/0a6105773d17884bbcb39d9bdd734ca5c42a64b8))

## [0.22.1](https://github.com/Nowhitestar/Yulu/compare/v0.22.0...v0.22.1) (2026-07-22)


### Bug Fixes

* **transcription:** harden realtime and batch reliability ([#105](https://github.com/Nowhitestar/Yulu/issues/105)) ([8a0adc0](https://github.com/Nowhitestar/Yulu/commit/8a0adc06ddd1a09c787ad3cacafd06cba0ddecfd))

## [0.22.0](https://github.com/Nowhitestar/Yulu/compare/v0.21.0...v0.22.0) (2026-07-17)


### Features

* **audio:** decouple transcription engines from Agents ([c0cffe6](https://github.com/Nowhitestar/Yulu/commit/c0cffe62361b4021d85dec19838ef108aa01a572))

## [0.21.0](https://github.com/Nowhitestar/Yulu/compare/v0.20.0...v0.21.0) (2026-07-15)


### Features

* **captions:** redesign realtime subtitles and translation ([5dee237](https://github.com/Nowhitestar/Yulu/commit/5dee237d95b4f8065588b3f56c2386c35df78e2a))

## [0.20.0](https://github.com/Nowhitestar/Yulu/compare/v0.19.0...v0.20.0) (2026-07-14)


### Features

* **recordings:** keep capture and transcription continuous ([#97](https://github.com/Nowhitestar/Yulu/issues/97)) ([f1fabf9](https://github.com/Nowhitestar/Yulu/commit/f1fabf9a829f194f7810f64142d746d1e451a2bb))

## [0.19.0](https://github.com/Nowhitestar/Yulu/compare/v0.18.1...v0.19.0) (2026-07-13)


### Features

* **recordings:** restore atomic meeting actions ([#95](https://github.com/Nowhitestar/Yulu/issues/95)) ([1d783fa](https://github.com/Nowhitestar/Yulu/commit/1d783fad64598fc332c5f720be2725db888aa749))

## [0.18.1](https://github.com/Nowhitestar/Yulu/compare/v0.18.0...v0.18.1) (2026-07-11)


### Bug Fixes

* **installer:** align runtime dependency checks ([#91](https://github.com/Nowhitestar/Yulu/issues/91)) ([a8a7a7d](https://github.com/Nowhitestar/Yulu/commit/a8a7a7db04d6dc427ad5575051f301c306c2f4bc))

## [0.18.0](https://github.com/Nowhitestar/Yulu/compare/v0.17.0...v0.18.0) (2026-07-11)


### Features

* **agent:** delegate recording pipeline to Hermes ([#87](https://github.com/Nowhitestar/Yulu/issues/87)) ([62e6411](https://github.com/Nowhitestar/Yulu/commit/62e64114ec48e8471c70df1c4e616b8a7e3b17b1))

## [0.17.0](https://github.com/Nowhitestar/Yulu/compare/v0.16.1...v0.17.0) (2026-07-11)


### Features

* **ui:** apply Yulu brand system and streamline workflows ([#85](https://github.com/Nowhitestar/Yulu/issues/85)) ([5a07539](https://github.com/Nowhitestar/Yulu/commit/5a07539a83506beb2e1f91f0f23bd904b3f0b23e))

## [0.16.1](https://github.com/Nowhitestar/Yulu/compare/v0.16.0...v0.16.1) (2026-07-09)


### Bug Fixes

* **audio:** serialize recorder state ([edda3c0](https://github.com/Nowhitestar/Yulu/commit/edda3c061042eadce568f56c372d72baab2cca16))
* **ui:** preserve settings array drafts ([f4823c9](https://github.com/Nowhitestar/Yulu/commit/f4823c9eefb3f43ac9a83e23f86383e9ddd918ff))

## [Unreleased]

### Bug Fixes

* **settings:** preserve draft values when editing automation match arrays.
* **audio:** serialize recorder state and preserve resumed segment paths.

## [0.16.0](https://github.com/Nowhitestar/Yulu/compare/v0.15.0...v0.16.0) (2026-07-09)


### Features

* add Yulu HTTP MCP server ([2e6f450](https://github.com/Nowhitestar/Yulu/commit/2e6f450cdfb6947f940952738a68027243b969b1))

## [0.15.0](https://github.com/Nowhitestar/Yulu/compare/v0.14.0...v0.15.0) (2026-07-09)


### Features

* add voice input workflow and streamline agent console ([f20c585](https://github.com/Nowhitestar/Yulu/commit/f20c585d31d32b8365f4b504e8afa09f3f14f46a))


### Bug Fixes

* **stt:** use calendar attendees for speaker names ([51d095e](https://github.com/Nowhitestar/Yulu/commit/51d095ed7adb4947925b060c5370c878e6e6ce14))
* **transcription:** reuse live transcripts and glossary for summaries ([c7e7738](https://github.com/Nowhitestar/Yulu/commit/c7e7738bede80fa13290bb124ac2db78305f83f7))
* **ui:** keep recorder window in saving state after stop ([a98ed47](https://github.com/Nowhitestar/Yulu/commit/a98ed47f86220769a2446064015e16d8090826d9))

## [0.14.0](https://github.com/Nowhitestar/Yulu/compare/v0.13.0...v0.14.0) (2026-06-30)


### Features

* **stt:** support Hermes transcription provider ([a3c7c32](https://github.com/Nowhitestar/Yulu/commit/a3c7c32210efb3f1c371e7396dd172ae6d98691e))

## [0.13.0](https://github.com/Nowhitestar/Yulu/compare/v0.12.0...v0.13.0) (2026-06-26)


### Features

* **agent-console:** ship agent-native workspace ([0420ef3](https://github.com/Nowhitestar/Yulu/commit/0420ef328707f56435ca433b84835e22da35665b))

## [0.12.0](https://github.com/Nowhitestar/Yulu/compare/v0.11.4...v0.12.0) (2026-06-24)


### Features

* **ui:** add liquid glass redesign ([ca9bb04](https://github.com/Nowhitestar/Yulu/commit/ca9bb0444ec0615b65ac4a872e4768cd5cbe7908))

## [0.11.4](https://github.com/Nowhitestar/Yulu/compare/v0.11.3...v0.11.4) (2026-06-17)


### Bug Fixes

* recover recording reprocess flows ([dcad5d4](https://github.com/Nowhitestar/Yulu/commit/dcad5d42d44e243a403ca128b0e0c4f02f582437))

## [0.11.3](https://github.com/Nowhitestar/Yulu/compare/v0.11.2...v0.11.3) (2026-06-15)


### Bug Fixes

* harden dual-track post processing ([6df4d62](https://github.com/Nowhitestar/Yulu/commit/6df4d628e65e7b1c73d61ea7f1e7303a75d59ae3))
* play original recording audio by default ([d549fd8](https://github.com/Nowhitestar/Yulu/commit/d549fd8be221085ea22efd0e1547a34f369b5c1d))
* suppress delayed dual-track playback echo ([5747b3c](https://github.com/Nowhitestar/Yulu/commit/5747b3ca5e7e0f7974d351b06a3ab4847409f80e))

## [0.11.2](https://github.com/Nowhitestar/Yulu/compare/v0.11.1...v0.11.2) (2026-06-15)


### Bug Fixes

* improve echo cleanup and settings refresh ([11ee3b7](https://github.com/Nowhitestar/Yulu/commit/11ee3b7e6e8feaab548e1e4058e464e72f822a40))
* **install:** add agent-native install and uninstall plans ([#61](https://github.com/Nowhitestar/Yulu/issues/61)) ([c4fb18a](https://github.com/Nowhitestar/Yulu/commit/c4fb18a64e95212a2366cdf6c4cae199daed22c5))
* keep realtime chunks out of recordings ([33f1ce5](https://github.com/Nowhitestar/Yulu/commit/33f1ce5c3a5f30247c81d07ac0515be8026760b4))

## [Unreleased]

### Changed

* **mcp:** add token-protected Yulu HTTP MCP registration via `yulu mcp ...`; install/update now registers detected local agents non-fatally, and uninstall cleans up the Yulu MCP entry.
* **transcription:** reuse complete realtime transcripts for fast summaries, copy summary Markdown from the reader, and apply glossary canonical terms to summaries.
* **install:** add agent-readable install/uninstall plan JSON and run PKG upgrades through the provision ledger. Existing installs do not require manual migration; agents can inspect install plans with `release_installer.py install --plan --json` and uninstall plans with `yulu uninstall --dry-run --json`.

## [0.11.1](https://github.com/Nowhitestar/Yulu/compare/v0.11.0...v0.11.1) (2026-06-14)


### Bug Fixes

* prevent pkg installer postinstall hangs ([990fb14](https://github.com/Nowhitestar/Yulu/commit/990fb14acc96a3be74f3d370b80e9450df994001))

## [0.11.0](https://github.com/Nowhitestar/Yulu/compare/v0.10.7...v0.11.0) (2026-06-14)


### Features

* add AI connector integrations ([f200a37](https://github.com/Nowhitestar/Yulu/commit/f200a37e59d09b22f1c91d205ad53baa94f6144d))

## [0.10.7](https://github.com/Nowhitestar/Yulu/compare/v0.10.6...v0.10.7) (2026-06-13)


### Bug Fixes

* **doctor:** treat release installs with install metadata as healthy sources

## [0.10.6](https://github.com/Nowhitestar/Yulu/compare/v0.10.5...v0.10.6) (2026-06-13)


### Features

* **recordings:** allow one-off speaker count overrides when re-transcribing
* **release:** publish a macOS pkg installer alongside the runtime zip


### Bug Fixes

* **recording:** start realtime transcription for menu/manual recordings
* **recording:** stop realtime subscribers promptly when recordings end
* **status:** build and package the recorder floating-window helper
* **settings:** clarify realtime transcription versus post-recording processing

## [0.10.5](https://github.com/Nowhitestar/Yulu/compare/v0.10.4...v0.10.5) (2026-06-12)


### Bug Fixes

* **audio:** boost microphone capture while preserving system playback clarity
* **install:** compile the status agent during dev installs
* **recording:** allow back-to-back recordings while the previous meeting is transcribing
* **recording:** treat queued agent summaries as successful async processing
* **recordings:** defer audio player mounting for faster meeting switching

## [0.10.4](https://github.com/Nowhitestar/Yulu/compare/v0.10.3...v0.10.4) (2026-06-12)


### Bug Fixes

* **setup:** preserve macOS recording permissions during normal upgrades

## [0.10.3](https://github.com/Nowhitestar/Yulu/compare/v0.10.2...v0.10.3) (2026-06-12)


### Bug Fixes

* **setup:** reinstall yulu_ui dependencies when node_modules is incomplete or built for another Node ABI

## [0.10.2](https://github.com/Nowhitestar/Yulu/compare/v0.10.1...v0.10.2) (2026-06-12)


### Bug Fixes

* **audio:** preserve mic audio when the system audio tap stalls and serialize tap recovery
* **diarize:** reduce auto speaker over-splitting with a less-sensitive clustering default
* **recordings:** flag header-only WAV files as recording failures
* **summary:** skip broken Codex wrappers and send direct summaries an explicit summary prompt

## [0.10.1](https://github.com/Nowhitestar/Yulu/compare/v0.10.0...v0.10.1) (2026-06-11)


### Bug Fixes

* **calendar:** resolve `gog` from common Homebrew PATHs in the settings integration UI
* **health:** parse launchd state from the stable table output and show on-demand workers as idle
* **recording:** preserve crashed recording files when appending agent-queue events
* **recordings:** show recording/transcription/summary failure states and add item context actions

## [0.10.0](https://github.com/Nowhitestar/Yulu/compare/v0.9.0...v0.10.0) (2026-06-10)


### Features

* **config:** transcription.diarization.* block in config.example.json ([3db009a](https://github.com/Nowhitestar/Yulu/commit/3db009a738d292fe00a948192ecbda38814d2948))
* **diarize:** calendar-attendee prior resolution in transcribe.py ([a0c9cd9](https://github.com/Nowhitestar/Yulu/commit/a0c9cd98125e324b880afc3c8a82e0c16636adb2))
* **diarize:** config-selected diarize backend construction held off the ASR dict ([d2f3dd5](https://github.com/Nowhitestar/Yulu/commit/d2f3dd5aafc52f11943996f976686d8e29a73f73))
* **diarize:** daemon DIARIZE RPC + request_diarize client ([7c31b3e](https://github.com/Nowhitestar/Yulu/commit/7c31b3eda16b8cbaa6f71187973c04fa571ff4d8))
* **diarize:** pure N-speaker merge core + .speakers.json sidecar ([3c0f067](https://github.com/Nowhitestar/Yulu/commit/3c0f06770594487cdb7f4f32b7a8e8a4d90c7383))
* **diarize:** SherpaDiarizeBackend + DiarizeBackend protocol + model resolution ([681c48c](https://github.com/Nowhitestar/Yulu/commit/681c48c5459c388cd7b8bf6b18cebe9ffd0c5a40))
* **diarize:** speaker-count strategy -- calendar prior + reconcile (over-split fix) ([73a91ab](https://github.com/Nowhitestar/Yulu/commit/73a91ab5f364172604ac180f53633dc8f5e41006))
* **diarize:** tri-state yulu-managed probe_diarization() folded into doctor ([33f5f6e](https://github.com/Nowhitestar/Yulu/commit/33f5f6e0b563dd7799c751782b1037baa38a8d3b))
* **diarize:** wire ASR->diarize->merge into transcribe.py pipeline ([1347e1d](https://github.com/Nowhitestar/Yulu/commit/1347e1daef7b3d903e266d17ea132952ff98021a))
* **eval:** torch-free DER/WDER/SER harness + constructed-corpus + RTTM + UI-copy ([92b9049](https://github.com/Nowhitestar/Yulu/commit/92b9049de22fdad4598fd8bf8c0d93ae4bd0fac8))
* **prompts:** {{speaker_transcript}}/{{speaker_list}} summary prompt vars ([7ee94d5](https://github.com/Nowhitestar/Yulu/commit/7ee94d56c1c8a689b9d8dd7df9806c581ed95384))
* **provision:** co-locate sherpa-onnx on the daemon interpreter (cp314 verified) + engine-aware models check ([44c04d4](https://github.com/Nowhitestar/Yulu/commit/44c04d4bc0c37aa0ce2e946e09850b91846c30b6))
* **provision:** idempotent diarization ONNX model provisioning in the models step ([b1d1032](https://github.com/Nowhitestar/Yulu/commit/b1d10320f88828b994d3531e1109a4afce3ba5b6))
* **settings:** add resource provisioning actions ([886d2b1](https://github.com/Nowhitestar/Yulu/commit/886d2b1d9f83354363cb2c492319dd23bd0765e3))
* **settings:** auto-detect gog accounts ([0930499](https://github.com/Nowhitestar/Yulu/commit/0930499959987b260f034a8f6b555f57fd78a5f8))
* **settings:** explain missing capabilities ([38da715](https://github.com/Nowhitestar/Yulu/commit/38da7153147e6edbfa8fb805e07a6a847da1c22c))
* **settings:** select watched calendars from gog ([a81d924](https://github.com/Nowhitestar/Yulu/commit/a81d924ac32c7d54c074d00fbf58da983a3660bc))
* harden phase14 settings and diarization readiness ([950b22c](https://github.com/Nowhitestar/Yulu/commit/950b22c24add42b02bcb0703f4cdbacca1abd7f6))


### Bug Fixes

* **audio:** keep dual-track capture on a continuous timeline ([73be113](https://github.com/Nowhitestar/Yulu/commit/73be113e4f87b95fc5a8f63ee701be484b5bdb50))
* **audio:** restore meeting half-duplex playback mix ([dba4723](https://github.com/Nowhitestar/Yulu/commit/dba47235a57b536b3fb605110e4b4730c4136e76))
* **diarize:** count-keyed pipeline cache so per-call override can't bleed into auto ([d2a6214](https://github.com/Nowhitestar/Yulu/commit/d2a6214e89ab94e7932a740b9aa6ccc68018293c))
* **diarize:** install soundfile with sherpa runtime ([5abfced](https://github.com/Nowhitestar/Yulu/commit/5abfced7e7337b8a8c70f53ff5a202efb59e6008))
* **recording:** resume interrupted captures and clean playback ([501d12f](https://github.com/Nowhitestar/Yulu/commit/501d12f365b47449586a10c1ec8820ff556098a0))
* **release:** grant tag publish workflow attestation permissions
* **ui:** improve mobile responsive layouts ([c7286f5](https://github.com/Nowhitestar/Yulu/commit/c7286f55e5b9356a7a4dc1fd70721376a1c42e23))

## [0.9.0](https://github.com/Nowhitestar/Yulu/compare/v0.8.0...v0.9.0) (2026-06-07)


### Features

* **settings:** 3-column MasterDetail settings UI + full section editing + app-wide i18n (P1–P4) ([#50](https://github.com/Nowhitestar/Yulu/issues/50)) ([98c6e31](https://github.com/Nowhitestar/Yulu/commit/98c6e312855a179eca0a153afa437d86bd305d91))
* **settings:** declarative registry + config-write correctness (P0) ([#49](https://github.com/Nowhitestar/Yulu/issues/49)) ([f1b53c9](https://github.com/Nowhitestar/Yulu/commit/f1b53c9333833168dbbc88fd5dbc516c9bf3b165))

## [0.8.0](https://github.com/Nowhitestar/Yulu/compare/v0.7.0...v0.8.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* voicemail is removed; every recording is a meeting. The Cmd+Shift+V mic-only hotkey, the voicemail-todos prompt, and the voicemails/ directory no longer exist. Existing voicemail_* recordings are renamed voicemail_* → Memo_* by an automatic migration on upgrade.

### Features

* remove voicemail entirely, unify into meeting ([#46](https://github.com/Nowhitestar/Yulu/issues/46)) ([5030f4c](https://github.com/Nowhitestar/Yulu/commit/5030f4c75b7cdfa05f9ec8b87ce05c716b14236e))

## [0.7.0](https://github.com/Nowhitestar/Yulu/compare/v0.6.0...v0.7.0) (2026-06-05)


### Features

* **ui:** recordings reader — markdown summary, transcript dedup, rename/tags/delete, real status ([#44](https://github.com/Nowhitestar/Yulu/issues/44)) ([8aace30](https://github.com/Nowhitestar/Yulu/commit/8aace308188569a43054234ea6380348d51e366c))


### Bug Fixes

* **audio:** self-heal stuck sys-tap so meetings start after a voicemail ([#43](https://github.com/Nowhitestar/Yulu/issues/43)) ([9aff28f](https://github.com/Nowhitestar/Yulu/commit/9aff28f20b0c4d247a587c23a7e2c86859486adc))
* make realtime transcription robust for arbitrarily-long recordings ([#42](https://github.com/Nowhitestar/Yulu/issues/42)) ([f05e641](https://github.com/Nowhitestar/Yulu/commit/f05e6418c4c963c526e6e494166eab49c126a4d1))
* repair 10 fresh-user-facing bugs in the v0.6.0 release ([#41](https://github.com/Nowhitestar/Yulu/issues/41)) ([53fa35c](https://github.com/Nowhitestar/Yulu/commit/53fa35cbf725cbd68805ab196379f6b3ead27e5a))

## [0.6.0](https://github.com/Nowhitestar/Yulu/compare/v0.5.2...v0.6.0) (2026-06-01)


### Features

* agent-native provisioning & cross-platform foundation (v0.5 milestone) ([#37](https://github.com/Nowhitestar/Yulu/issues/37)) ([b18164d](https://github.com/Nowhitestar/Yulu/commit/b18164d99ba1b323b826277cb42202497aebb972))

## [0.5.2](https://github.com/Nowhitestar/Yulu/compare/v0.5.1...v0.5.2) (2026-05-29)


### Bug Fixes

* stabilize meeting-detector signature; persistent record dialog ([#35](https://github.com/Nowhitestar/Yulu/issues/35)) ([61ed4a9](https://github.com/Nowhitestar/Yulu/commit/61ed4a93891b45e005c107bf3b432d2d6eae4882))

## [0.5.1](https://github.com/Nowhitestar/Yulu/compare/v0.5.0...v0.5.1) (2026-05-29)


### Bug Fixes

* restore exec bits on release extract; harden setup & packaging ([#31](https://github.com/Nowhitestar/Yulu/issues/31)) ([82b0ab2](https://github.com/Nowhitestar/Yulu/commit/82b0ab26ed4c893dd0e8578bd254f8ef918b4c25))

## [Unreleased]

### Fixed
- **Settings now reflect and control the installed runtime.** Audio device choices come from the native CoreAudio daemon, capture settings take effect on the next recording without an unnecessary daemon restart, invalid local-Japanese transcription combinations are rejected, save/apply/restart failures are visible, and StatusAgent shows configured versus live service state without duplicate or non-editable controls.
- **Release installs lost Unix executable bits.** `release_installer.py` used `ZipFile.extractall()`, which does not restore the mode stored in each entry's `external_attr` — every file (including the `Yulu.app` / `StatusAgent.app` Mach-O binaries launchd spawns directly) landed as `0644`, so the menu-bar agent and audio daemon failed with "Launchd job spawn failed" on a fresh install. The installer now re-applies each entry's recorded permission bits after extraction.
- **`setup.sh` aborted under non-interactive stdin.** The optional agent-skill registration `read` returned non-zero at EOF and, under `set -e`, failed the whole run — which triggered an install rollback. The `read`s now tolerate EOF.
- **`setup.sh` self-heals `.app` exec bits.** `chmod +x` is re-asserted on the bundled binaries before launch, so existing installs recover on `yulu update` even when extracted by an older installer.

### Changed
- **Packaging hardening.** `package.sh` re-asserts `+x` on git-executable files in the staged tree before zipping, so release archives carry correct modes even if the source checkout's permission bits drift.

## [0.5.0] - 2026-05-29

### Added
- **Yulu web UI** — a unified localhost interface at `http://127.0.0.1:7777`: recordings inbox + reader (audio player, transcript, summary, re-transcribe/re-generate), single Settings page (Audio / Transcription / LLM / Hotkey & UI / Integrations / Storage), Knowledge (Prompts + Glossary), Health (daemons + logs), and a ⌘K global search. Served by a Node + Hono + tRPC server (`com.yulu.ui` LaunchAgent); `yulu logs ui` tails it.
- **Voicemail realtime transcription** with a global Settings toggle (`transcription.realtime_enabled`, default on). On stop the live transcript is promoted to the final transcript; an empty/missing realtime transcript falls back to whole-file transcription.
- Central version management via the root `VERSION` file and `yulu/scripts/version.py`; `yulu version` now prints the installed version plus git metadata for support/debugging.
- Release-asset based installer/updater (`yulu update [--latest|--version vX.Y.Z|--dev]`) with sha256-verified packages.
- Packaging scripts and a tag-triggered GitHub Actions workflow for `yulu-macos-arm64-<version>.zip`, `install.sh`, and `checksums.txt`.
- MLX transcription `final_model` and `preprocess_audio` options.

### Changed
- Default MLX model is now `mlx-community/whisper-large-v3-turbo`.
- Rewrote the meeting summary template to a concise, action-oriented format (一句话结论 / 重点 / 下步动作).
- Default install/update path from main checkout to stable release assets.
- Upgraded build/test tooling — vite 6, vitest 3, esbuild 0.25 — clearing dev-tooling security advisories (production serves a prebuilt static bundle and is unaffected).

### Fixed
- `read_realtime_transcript` now ignores agent-event JSON payloads (treats them as "no transcript" and falls back to whole-file transcription).
- Removed the vestigial `audio.realtime_transcribe` config default; `transcription.realtime_enabled` is the single source of truth (legacy key still honored as a fallback).

## [0.4.0] - 2026-05-08

### Fixed
- `install.sh`: `[[ -e /dev/tty ]]` could be true while the device wasn't actually openable (CI runners, sandboxed agents, certain SSH sessions), causing the install to bail with `/dev/tty: Device not configured` before `setup.sh` ever ran. Now we cascade through `[[ -t 0 ]]` (stdin already a tty) → `(exec 3</dev/tty) 2>/dev/null` (try to open it for real) → `< /dev/null` (truly non-interactive, fall back to defaults). First shipped as a hotfix to `v0.3.0`.
- **`Yulu.app` no longer triggers the macOS "screen recording in progress" indicator while idle.** Previously the daemon opened an `SCStream` 1 second after launch and kept it alive forever (writing samples only while `recording=true`, but the stream itself counts as "in use" to macOS). The menu-bar purple dot stayed on permanently. Now the daemon only probes the TCC permission at startup (open → immediately stop), and re-opens the `SCStream` only when a recording actually begins. Same change for the microphone engine — the orange dot also clears when idle. Recording-start latency goes from <100 ms to roughly 4 s on cold start (the first `SCShareableContent.current` + `SCStream` init are slow); subsequent starts within the same daemon process are faster. The user-visible "Recording started" message now appears only when the stream is actually ready to receive samples.
- `AudioCapture.startCapture()` and `stopCapture()` are now synchronous (block on a `DispatchSemaphore` until the underlying `SCStream` Task transitions). Without this, a fast stop after start could see `stream==nil` and no-op, then the start Task would finish AFTER the stop and leave the stream alive — the macOS recording indicator stayed on after the user clicked stop.
- `SocketServer` `stop` action no longer fires `onRecordingStop` when the recorder wasn't actually running. Previously a spurious `stop` (e.g. client retry after `start_failed`) logged fake "Sys capture idle" / "Mic idle" lines.
- `setup.sh --upgrade` fast-path (when `sysReady=true` is already cached) now `pkill -9` the daemon and lets `launchd` `KeepAlive` respawn the freshly built binary. Previously `launchctl unload` of an `open -W Yulu.app` job killed only the `open` wrapper, not the LSUIElement child process — so `yulu update` shipped code changes that never actually ran until the user rebooted. TCC state is preserved (no `tccutil reset` in the fast-path).

### Changed
- `setup.sh` now runs `tccutil reset ScreenCapture com.yulu.audiodaemon` and `tccutil reset Microphone com.yulu.audiodaemon` before relaunching `Yulu.app` on the first-grant path (after stopping the running daemon). This guarantees macOS shows the permission dialog instead of silently honoring a previously-denied state. If you'd accidentally clicked "Don't Allow" the first time around, you no longer have to dig into System Settings to recover — re-running setup is enough. Already-granted users on the upgrade fast-path don't see a re-prompt.

## [0.3.0] - 2026-05-08

### Added
- **One-line installer**: `curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash`. The installer pre-flights macOS / Xcode CLI / git, clones to `~/.yulu/` (a stable path), then hands off to `setup.sh`. If a previous installation is detected (any `com.yulu.*` LaunchAgent in `~/Library/LaunchAgents/`), it runs in `--upgrade` mode automatically.
- **`yulu` CLI** (`yulu/scripts/yulu`, symlinked to `~/.local/bin/yulu` by setup): single command surface for `setup`, `update`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`, `record start/stop`, `where`. Symlink-resolved so the CLI keeps working even if the repo path changes.
- **`setup.sh --upgrade` mode**: idempotent re-run. Skips already-granted TCC, already-authed Google OAuth, already-downloaded whisper model, already-existing config. Used by `yulu update` and the installer's auto-detect.
- **`yulu/scripts/uninstall.sh`** (`yulu uninstall`): stops services, removes LaunchAgents and the CLI; prompts before deleting recordings, config, or registered agent skills; prints the manual-cleanup pointers for TCC and Homebrew packages.
- **whisper.cpp model download in setup**: a new step lets the user pick `base` / `small` / `medium` / `large-v3-q5_0` / `large-v3` (default `large-v3-q5_0`, ~1.1 GB), downloads to `~/.config/yulu/models/`, and writes the explicit `whisper-cli -m …` command into `config.json` so transcription works on first use. Previously users hit a missing-model failure on their first meeting.
- **Yulu now ships as an [open agent skill](https://github.com/vercel-labs/skills)**. `skills/yulu/SKILL.md` documents the verbs Yulu exposes (start / stop / status / fulfill `summary_request` / find a past meeting) so any agent in the `vercel-labs/skills` ecosystem (Claude Code, OpenClaw, Codex, Cursor, and 50+ others) can drive Yulu from natural language. Install with `npx skills add Nowhitestar/Yulu -g -a claude-code -a openclaw -y`; `setup.sh` offers to do it for you. The skill is a thin contract — `setup.sh` is still required for the macOS app, launchd services, and whisper.cpp install.

### Changed
- **Default recording directory is now `~/Movies/Yulu/`** instead of `<repo>/meeting-recordings/`. New installs get `~/Movies/Yulu`; existing installs honor whatever `audio.output_dir` was already set to in `config.json`. This decouples the recordings from the repo clone — moving or deleting `~/.yulu/` no longer takes your meeting history with it.
- **`setup.sh` no longer clears the terminal** on launch — the user's `cd` history and pre-install context are preserved for debugging.
- **`Yulu.app` quarantine attribute is stripped after build** (`xattr -dr com.apple.quarantine`) so the ad-hoc-signed bundle launches without the silent Gatekeeper block that LSUIElement apps swallow.
- Test step labels in `run_tests` are now consistent (`1/4` … `4/4`).
- The "Python 3.14" suggestion in `check_system` is now just `brew install python` (3.14 was a moving target).

### Removed
- The legacy `git clone … && cd Yulu && bash yulu/scripts/setup.sh` instruction in both READMEs is replaced by the one-line installer. Manual setup is still documented for hackers, but the headline path is now `curl … | bash`.

## [0.2.0] - 2026-05-08

### Changed
- Renamed the audio daemon bundle path from `yulu/scripts/AudioDaemon.app` to `yulu/scripts/Yulu.app` so that System Settings, Activity Monitor, the Dock, and TCC prompts identify the app as **Yulu** end-to-end. The `audio_daemon` executable name, `com.yulu.audiodaemon` bundle id, `com.yulu.audiodaemon` LaunchAgent label, and `~/.config/yulu/audio_daemon.sock` socket path are unchanged — TCC permissions granted in 0.1.0 are preserved.
- User-facing log messages, setup prompts, and documentation now refer to "Yulu" instead of "AudioDaemon" wherever the user is the audience. Internal identifiers (`audio_daemon` binary, `com.yulu.audiodaemon` bundle id, socket name) are deliberately kept.

### Removed
- `yulu/scripts/migrate_to_yulu.sh` and the "Upgrading from `meeting-assistant`" section of both READMEs. The pre-rename `meeting-assistant` codename never had a public release, so there are no installs in the wild that need migrating off it. The `setup.sh` legacy-install detector that prompted users to run the migration script is also gone.
- `assets/demos/README.md` placeholder — the four demo screenshots it described were committed in 0.1.0, so the placeholder is no longer needed.

## [0.1.0] - 2026-05-07

### Added
- Initial public release as **Yulu** (语录).
- Native macOS recording via `ScreenCaptureKit` (system audio) + `AVFoundation` (microphone), no BlackHole required.
- Signed `Yulu.app` Unix-socket controller.
- Half-duplex mixing: prioritize system audio, fade to microphone during system silence.
- Floating recording status window with a manual stop button.
- Local transcription via `whisper.cpp` (`whisper-cli`).
- Agent-queue-based summarization: any agent (Claude Code, Codex, OpenClaw…) can consume `agent-queue.json` and write back `summary.md` from `summary_template.md`.
- Optional bring-your-own-LLM external command path in `transcribe.py`.
- Google Calendar integration via `gog` with refresh tokens stored in macOS Keychain.
- Window-based meeting detection for Zoom, Tencent Meeting, Google Meet, Feishu/Lark, WeChat calls, and browser meetings.
- LaunchAgent definitions for scheduler, detector, calendar, and audio daemons.

### Changed (breaking)
- Project renamed from `meeting-assistant` to **Yulu** for the public release.
  - Repository directory: `meeting-assistant/` → `yulu/`
  - User config dir: `~/.config/meeting-assistant/` → `~/.config/yulu/`
  - LaunchAgent labels: `com.meetingassistant.*` → `com.yulu.*`
  - AudioDaemon bundle id: `com.meetingassistant.audiodaemon` → `com.yulu.audiodaemon`
  - Skill package: `meeting-assistant.skill` → `yulu.skill`
  - Code-signing env var: `MEETING_ASSISTANT_CODESIGN_IDENTITY` → `YULU_CODESIGN_IDENTITY`
- Existing users: run `bash yulu/scripts/migrate_to_yulu.sh` once before re-running `setup.sh`. The bundle-id change means macOS will prompt for Microphone and Screen & System Audio Recording permissions again — that is expected.

### Removed
- Hardcoded personal Apple Developer email in `build_audio_daemon.sh`. Code-signing now defaults to "Developer ID Application" → "Apple Development" → ad-hoc, all auto-detected.

### Security
- Removed all hardcoded Google OAuth secrets from the repository history.
- `.gitignore` blocks `config.json`, `client_secret*.json`, `credentials*.json`, `token*.json`, and local recordings by default.

[Unreleased]: https://github.com/Nowhitestar/Yulu/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Nowhitestar/Yulu/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Nowhitestar/Yulu/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Nowhitestar/Yulu/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nowhitestar/Yulu/releases/tag/v0.1.0
