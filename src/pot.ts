import {
  BG,
  BgConfig,
  buildURL,
  DescrambledChallenge,
  FetchFunction,
  USER_AGENT,
  WebPoSignalOutput,
} from "npm:bgutils-js@3.2.0";
import { JSDOM, VirtualConsole } from "npm:jsdom@29";
import { type Context as InnertubeContext, Innertube } from "npm:youtubei.js";
import type { PotTokens } from "./potCache.ts";
import { isSessionBound } from "./potBinding.ts";

const YT_BASE = "https://www.youtube.com";
const TV_CONFIG_URL =
  "https://www.youtube.com/tv_config?action_get_config=true&client=lb4&theme=cl";
const TV_USER_AGENT =
  "Mozilla/5.0 (Linux arm64-v8a; Android 10) Cobalt/25.lts.30.1034958-gold (unlike Gecko) v8/8.8.278.17-jit gles Starboard/15, Sony_ATV_sdm845_13140765/52.1.C.0.268 (KDDI, SOV38) com.google.android.youtube.tv/5.30.301";
const WEB_CLIENT_NAME = "WEB";
const WEB_CLIENT_VERSION = "2.20260227.01.00";
const GOOG_API_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";

const CREATE_USE_YT_API = Deno.env.get("POT_CREATE_USE_YT_API") === "true";
const GENERATEIT_USE_YT_API =
  Deno.env.get("POT_GENERATEIT_USE_YT_API") !== "false";

/** A BotGuard challenge plus the request key that produced it. The two must match. */
type ChallengeResult = {
  challenge: DescrambledChallenge;
  requestKey: string;
  source: string;
};

type TokenMinter = {
  expiry: Date;
  integrityToken: string;
  minter: any;
};

/** The four VM entry points BotGuard hands back through its setup callback. */
type VmFunctions = {
  asyncSnapshot: (callback: (response: string) => void, args: any[]) => void;
  shutdown?: (...args: any[]) => void;
  passEvent?: (...args: any[]) => void;
  checkCamera?: (...args: any[]) => void;
};

/**
 * Parse the object literals YouTube inlines in its HTML. Unquoted keys, single-quoted strings,
 * `\xNN` escapes and trailing commas are legal there but not in JSON.
 */
function parseLooseJson(input: string): any {
  const normalized = input
    .replace(
      /\\x([0-9a-f]{2})/gi,
      (_, hex) => String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/,\s*([}\]])/g, "$1")
    .replace(
      /'((?:[^'\\]|\\[\s\S])*)'/g,
      (_, s) => JSON.stringify(s.replace(/\\'/g, "'")),
    )
    .replace(/([{,]\s*)([\w$]+)\s*:/g, '$1"$2":');

  const parsed = JSON.parse(normalized);
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && /^\s*[{[]/.test(value)) {
      try {
        parsed[key] = JSON.parse(value);
      } catch { /* keep the raw string */ }
    }
  }
  return parsed;
}

/** Fold the several shapes of a `bgChallenge` into one. */
function toDescrambledChallenge(
  bgChallenge: any,
): DescrambledChallenge | undefined {
  if (!bgChallenge?.program || !bgChallenge?.globalName) return undefined;
  return {
    messageId: bgChallenge.messageId,
    program: bgChallenge.program,
    globalName: bgChallenge.globalName,
    interpreterHash: bgChallenge.interpreterHash ?? "",
    interpreterJavascript: {
      privateDoNotAccessOrElseSafeScriptWrappedValue:
        bgChallenge.interpreterJavascript
          ?.privateDoNotAccessOrElseSafeScriptWrappedValue ?? null,
      privateDoNotAccessOrElseTrustedResourceUrlWrappedValue:
        bgChallenge.interpreterUrl
          ?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue ??
          bgChallenge.interpreterJavascript
            ?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue ??
          null,
    },
    clientExperimentsStateBlob: bgChallenge.clientExperimentsStateBlob,
  };
}

export class PoTokenManager {
  private static readonly REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
  private static hasDom = false;
  private _minterCache: Map<string, TokenMinter> = new Map();
  private innertube?: Innertube;

  constructor() {
    if (!PoTokenManager.hasDom) {
      const virtualConsole = new VirtualConsole().forwardTo(console, {
        jsdomErrors: ["unhandled-exception", "resource-loading", "css-parsing"],
      });

      const dom = new JSDOM(
        '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
        {
          url: "https://www.youtube.com/",
          referrer: "https://www.youtube.com/",
          userAgent: USER_AGENT,
          virtualConsole,
        },
      );

      const globals = {
        window: dom.window,
        document: dom.window.document,
        location: dom.window.location,
        origin: dom.window.origin,
        navigator: dom.window.navigator,
      };

      // A worker global has location, origin and navigator as getters, so assigning them throws.
      for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, {
          value,
          writable: true,
          configurable: true,
        });
      }
      PoTokenManager.hasDom = true;
    }
  }

  private async getInnertube(): Promise<Innertube> {
    if (!this.innertube) {
      this.innertube = await Innertube.create({ retrieve_player: false });
    }
    return this.innertube;
  }

  private async generateVisitorData(): Promise<string | null> {
    try {
      const innertube = await this.getInnertube();
      const visitorData = innertube.session.context.client.visitorData;
      return visitorData || null;
    } catch (e) {
      console.error("Failed to generate visitor data:", e);
      return null;
    }
  }

  /**
   * The challenge program and the request key sent to `GenerateIT` have to come from the same
   * handshake, so every source returns its own key. A mismatched pair still mints a token, but the
   * streaming backend never attests it and the SABR session parks at `StreamProtectionStatus=2`.
   * Sources are ordered by observed success rate.
   */
  private async getDescrambledChallenge(
    bgConfig: BgConfig,
    innertubeContext?: InnertubeContext,
  ): Promise<ChallengeResult> {
    const attempts: Array<() => Promise<ChallengeResult | undefined>> = [
      () => this.challengeFromHomePage(bgConfig),
      () => this.challengeFromTvConfig(bgConfig),
      () => this.challengeFromWaa(bgConfig),
      () => this.challengeFromAttGet(bgConfig, innertubeContext),
    ];

    for (const attempt of attempts) {
      try {
        const result = await attempt();
        if (result) {
          console.log(
            `BotGuard challenge acquired from ${result.source} (globalName=${result.challenge.globalName})`,
          );
          return result;
        }
      } catch (e) {
        console.warn(
          "BotGuard challenge source failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    throw new Error("Could not get Botguard challenge");
  }

  /** The YouTube home page: `ytcfg.set({...})` plus the inline `window.ytAtN({R: ...})`. */
  private async challengeFromHomePage(
    bgConfig: BgConfig,
  ): Promise<ChallengeResult | undefined> {
    const response = await bgConfig.fetch(YT_BASE, {
      headers: {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.7",
        "user-agent": USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`youtube.com returned ${response.status}`);
    }
    const html = await response.text();

    // The VM reads experiment flags and the client config out of `yt.config_`.
    const config = html.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
    if (config) {
      const yt = { config_: JSON.parse(config) };
      (globalThis as any).window.yt = yt;
      (globalThis as any).yt = yt;
    }

    const attestation = html.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
    if (!attestation) return undefined;

    const challenge = toDescrambledChallenge(
      parseLooseJson(attestation[1]).R?.bgChallenge,
    );
    if (!challenge) return undefined;
    return {
      challenge,
      requestKey: PoTokenManager.REQUEST_KEY,
      source: "home page",
    };
  }

  /** The TV config endpoint, which names its own `challengeRequestKey`. */
  private async challengeFromTvConfig(
    bgConfig: BgConfig,
  ): Promise<ChallengeResult | undefined> {
    const response = await bgConfig.fetch(TV_CONFIG_URL, {
      headers: { "accept": "*/*", "user-agent": TV_USER_AGENT },
    });
    if (!response.ok) throw new Error(`tv_config returned ${response.status}`);
    const text = await response.text();
    // The response is JSON behind an anti-hijacking `)]}` guard.
    if (!text.startsWith(")]}")) {
      throw new Error("invalid yt tv_config response");
    }

    const json = JSON.parse(text.slice(4));
    if (!json.challengeParams?.R) return undefined;

    const challenge = toDescrambledChallenge(
      JSON.parse(json.challengeParams.R).bgChallenge,
    );
    if (!challenge) return undefined;
    return {
      challenge,
      requestKey: json.challengeRequestKey || PoTokenManager.REQUEST_KEY,
      source: "tv_config",
    };
  }

  /** The canonical WebPO handshake: `Create` on Google's WAA service. */
  private async challengeFromWaa(
    bgConfig: BgConfig,
  ): Promise<ChallengeResult | undefined> {
    const challenge = await BG.Challenge.create({
      ...bgConfig,
      useYouTubeAPI: CREATE_USE_YT_API,
    });
    if (!challenge?.program || !challenge?.globalName) return undefined;
    return {
      challenge,
      requestKey: bgConfig.requestKey,
      source: CREATE_USE_YT_API ? "youtube Create" : "WAA Create",
    };
  }

  /**
   * Innertube `att/get`. Last resort: it answers the engagement attestation flow, so its program
   * may not match the WebPO request key we send to `GenerateIT`.
   */
  private async challengeFromAttGet(
    bgConfig: BgConfig,
    innertubeContext?: InnertubeContext,
  ): Promise<ChallengeResult | undefined> {
    if (!innertubeContext) {
      const innertube = await this.getInnertube();
      innertubeContext = innertube.session.context;
    }
    const context = innertubeContext ?? {
      client: {
        clientName: WEB_CLIENT_NAME,
        clientVersion: WEB_CLIENT_VERSION,
      },
    };

    const response = await bgConfig.fetch(
      `${YT_BASE}/youtubei/v1/att/get?prettyPrint=false`,
      {
        method: "POST",
        headers: {
          "accept": "*/*",
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          "x-goog-api-key": GOOG_API_KEY,
        },
        body: JSON.stringify({
          context,
          engagementType: "ENGAGEMENT_TYPE_UNBOUND",
        }),
      },
    );
    if (!response.ok) throw new Error(`att/get returned ${response.status}`);

    const attestation = await response.json();
    const challenge = toDescrambledChallenge(attestation?.bgChallenge);
    if (!challenge) return undefined;
    return {
      challenge,
      requestKey: PoTokenManager.REQUEST_KEY,
      source: "att/get",
    };
  }

  /**
   * The VM init function `a` wants nine arguments for the current program. bgutils-js 3.2.0 passes
   * six, which the VM accepts while producing a snapshot the streaming backend refuses to attest,
   * so the call is made here instead.
   */
  private async loadVm(
    challenge: DescrambledChallenge,
    globalObj: Record<string, any>,
    fetchFn: FetchFunction,
  ): Promise<{ snapshot: (args: any) => Promise<string> }> {
    const inline = challenge.interpreterJavascript
      ?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    const url = challenge.interpreterJavascript
      ?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;

    const interpreter = inline ||
      (url
        ? await (await fetchFn(url.startsWith("http") ? url : `https:${url}`))
          .text()
        : "");
    if (!interpreter) throw new Error("Could not load VM");

    new Function(interpreter)();

    const vm = globalObj[challenge.globalName];
    if (!vm) throw new Error("BotGuard VM unavailable");
    if (!vm.a) throw new Error("BotGuard VM init function unavailable");

    let resolveVmFunctions!: (value: VmFunctions) => void;
    const vmFunctions = new Promise<VmFunctions>((resolve) => {
      resolveVmFunctions = resolve;
    });

    const vmSetupCallback = (
      asyncSnapshot: VmFunctions["asyncSnapshot"],
      shutdown: VmFunctions["shutdown"],
      passEvent: VmFunctions["passEvent"],
      checkCamera: VmFunctions["checkCamera"],
    ) =>
      resolveVmFunctions({ asyncSnapshot, shutdown, passEvent, checkCamera });

    // Clearcut telemetry hooks. The VM calls them positionally, so all five have to be there.
    const loggerFunctions = [() => {}, () => {}, () => {}, () => {}, () => {}];

    await vm.a(
      challenge.program,
      vmSetupCallback,
      true,
      undefined,
      () => {},
      [[], []],
      undefined,
      false,
      loggerFunctions,
    );

    return {
      snapshot: async (args: any) => {
        const { asyncSnapshot } = await vmFunctions;
        return await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("VM operation timed out")),
            10_000,
          );
          asyncSnapshot((response: string) => {
            clearTimeout(timer);
            resolve(response);
          }, [
            args.contentBinding,
            args.signedTimestamp,
            args.webPoSignalOutput,
            args.skipPrivacyBuffer,
          ]);
        });
      },
    };
  }

  private async generateTokenMinter(
    bgConfig: BgConfig,
    innertubeContext?: InnertubeContext,
  ): Promise<TokenMinter> {
    const { challenge, requestKey } = await this.getDescrambledChallenge(
      bgConfig,
      innertubeContext,
    );

    const vm = await this.loadVm(challenge, bgConfig.globalObj, bgConfig.fetch);

    const webPoSignalOutput: WebPoSignalOutput = [];
    const botguardResponse = await vm.snapshot({ webPoSignalOutput });

    const integrityTokenResp = await bgConfig.fetch(
      buildURL("GenerateIT", GENERATEIT_USE_YT_API),
      {
        method: "POST",
        headers: {
          "content-type": "application/json+protobuf",
          "x-goog-api-key": GOOG_API_KEY,
          "x-user-agent": "grpc-web-javascript/0.1",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify([requestKey, botguardResponse]),
      },
    );
    if (!integrityTokenResp.ok) {
      throw new Error(`GenerateIT returned ${integrityTokenResp.status}`);
    }

    const [
      integrityToken,
      estimatedTtlSecs,
      mintRefreshThreshold,
      websafeFallbackToken,
    ] = await integrityTokenResp.json();

    const integrityTokenData = {
      integrityToken,
      estimatedTtlSecs,
      mintRefreshThreshold,
      websafeFallbackToken,
    };

    if (!integrityToken) throw new Error("Unexpected empty integrity token");

    // Retire the minter early so an in-flight mint never lands on an expired integrity token.
    const ttlSecs = Number(estimatedTtlSecs);
    const lifetimeSecs = Math.max(
      1,
      (Number.isFinite(ttlSecs) && ttlSecs > 0 ? ttlSecs : 300) - 30,
    );

    const tokenMinter: TokenMinter = {
      expiry: new Date(Date.now() + lifetimeSecs * 1000),
      integrityToken,
      minter: await BG.WebPoMinter.create(
        integrityTokenData,
        webPoSignalOutput,
      ),
    };

    console.log(
      `BotGuard integrity token minted (ttl=${ttlSecs}s, expires=${tokenMinter.expiry.toISOString()})`,
    );

    this._minterCache.set("default", tokenMinter);
    return tokenMinter;
  }

  async generatePoToken(
    visitorData?: string,
    videoId?: string,
    client?: string,
  ): Promise<PotTokens> {
    if (!visitorData) {
      visitorData = (await this.generateVisitorData()) || undefined;
      if (!visitorData) throw new Error("Unable to generate visitor data");
    }

    const bgConfig: BgConfig = {
      fetch: (input, init) => fetch(input, init),
      globalObj: globalThis as any,
      identifier: visitorData,
      requestKey: PoTokenManager.REQUEST_KEY,
    };

    let tokenMinter = this._minterCache.get("default");
    if (!tokenMinter || new Date() >= tokenMinter.expiry) {
      const innertube = await this.getInnertube();
      tokenMinter = await this.generateTokenMinter(
        bgConfig,
        innertube.session.context,
      );
    }

    const visitorDataToken = await mint(tokenMinter.minter, visitorData);

    // A session bound client binds its video token to visitorData, so it is the visitor token.
    const videoIdToken = !videoId
      ? undefined
      : isSessionBound(client)
      ? visitorDataToken
      : await mint(tokenMinter.minter, videoId);

    return { visitorDataToken, visitorData, videoIdToken };
  }
}

async function mint(minter: any, binding: string): Promise<string> {
  const token = await minter.mintAsWebsafeString(binding);
  if (!token) throw new Error("Unexpected empty POT");
  return token;
}

export const potManager = new PoTokenManager();
