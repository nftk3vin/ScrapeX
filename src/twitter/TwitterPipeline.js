import inquirer from "inquirer";
import chalk from "chalk";
import path from "path";
import fs from "fs/promises";
import { format } from "date-fns";
import { Cookie } from "tough-cookie";

import { Scraper, SearchMode } from "agent-twitter-client";

import Logger from "./Logger.js";
import DataOrganizer from "./DataOrganizer.js";
import TweetFilter from "./TweetFilter.js";

export default class TwitterPipeline {
  constructor(username) {
    this.username = username;
    this.dataOrganizer = new DataOrganizer("pipeline", username);
    this.paths = this.dataOrganizer.getPaths();
    this.tweetFilter = new TweetFilter();

    this.paths.cookiesFile = path.join(
      process.cwd(),
      "cookies",
      `${process.env.TWITTER_USERNAME}_agent_cookies.json`
    );

    const MAX_TWEETS = parseInt(process.env.MAX_TWEETS, 10) || 10000;
    const MIN_DELAY = parseInt(process.env.MIN_DELAY, 10) || 1000;
    const MAX_DELAY = parseInt(process.env.MAX_DELAY, 10) || 3000;

    this.config = {
      twitter: {
        maxTweets: MAX_TWEETS,
        maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 5,
        retryDelay: parseInt(process.env.RETRY_DELAY, 10) || 3000,
        minDelay: MIN_DELAY,
        maxDelay: MAX_DELAY,
      },
    };

    this.scraper = new Scraper();

    this.stats = {
      startTime: Date.now(),
      rateLimitHits: 0,
    };
  }

  async validateEnvironment() {
    Logger.startSpinner("Validating environment");
    const required = ["TWITTER_USERNAME", "TWITTER_PASSWORD"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      Logger.stopSpinner(false);
      Logger.error("Missing env vars:", missing.join(", "));
      process.exit(1);
    }
    Logger.stopSpinner();
  }

  async loadCookies() {
    const filePath = this.paths.cookiesFile;
    try {
      await fs.access(filePath);
      const raw = await fs.readFile(filePath, "utf-8");
      const arr = JSON.parse(raw);
      Logger.info("[loadCookies] Original cookies =>", arr);
      const setCookieStrings = arr
        .map((c) => {
          const key = c.key || c.name;
          if (!key) return null;
          let value = c.value || "";
          if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
            value = value.slice(1, -1);
          }
          if (!value) return null;
          const cookieData = {
            key,
            value,
            domain: c.domain || "twitter.com",
            path: c.path || "/",
            secure: c.secure ?? true,
            httpOnly: c.httpOnly ?? false,
          };
          const toughC = Cookie.fromJSON(cookieData);
          if (!toughC) return null;
          const parts = [
            `${toughC.key}=${toughC.value}`,
            `Domain=${toughC.domain}`,
            `Path=${toughC.path}`,
          ];
          if (toughC.secure) parts.push("Secure");
          if (toughC.httpOnly) parts.push("HttpOnly");
          return parts.join("; ");
        })
        .filter(Boolean);
      if (!setCookieStrings.length) {
        throw new Error("No valid cookies after parse => can't set them");
      }
      Logger.info("[loadCookies] Final set-cookie array =>", setCookieStrings);
      await this.scraper.setCookies(setCookieStrings);
      Logger.success(`✅ Loaded cookies from => ${filePath}`);
      return true;
    } catch (err) {
      Logger.warn(`[loadCookies] => ${err.message}`);
      return false;
    }
  }

  async saveCookies() {
    const filePath = this.paths.cookiesFile;
    try {
      const agentCookies = await this.scraper.getCookies();
      const arr = agentCookies
        .map((c) => {
          if (!c.key || !c.value) return null;
          const cookieData = {
            key: c.key,
            value: c.value,
            domain: c.domain || "twitter.com",
            path: c.path || "/",
            secure: true,
            httpOnly: false,
          };
          const toughC = Cookie.fromJSON(cookieData);
          if (!toughC) return null;
          return toughC.toJSON();
        })
        .filter(Boolean);
      if (!arr.length) {
        throw new Error("No valid cookies to save from agent!");
      }
      Logger.info("[saveCookies] => Final cookies =>", arr);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(arr, null, 2), "utf-8");
      Logger.success(`✅ Saved cookies => ${filePath}`);
    } catch (err) {
      Logger.warn(`[saveCookies] => ${err.message}`);
    }
  }

  async initializeScraper() {
    Logger.startSpinner("Initializing agent w/ tough-cookie approach");
    const cookiesLoaded = await this.loadCookies();
    if (cookiesLoaded) {
      try {
        if (await this.scraper.isLoggedIn()) {
          Logger.success("✅ Auth via saved cookies");
          Logger.stopSpinner();
          return true;
        } else {
          Logger.warn("Cookies loaded => but session invalid");
        }
      } catch (err) {
        Logger.warn(`Cookie check => fresh login needed => ${err.message}`);
      }
    }
    Logger.warn("No valid cookie session => logging in fresh...");
    const user = process.env.TWITTER_USERNAME;
    const pass = process.env.TWITTER_PASSWORD;
    const email = process.env.TWITTER_EMAIL || undefined;
    const maxRetries = this.config.twitter.maxRetries;
    const retryDelay = this.config.twitter.retryDelay;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.scraper.login(user, pass, email);
        if (await this.scraper.isLoggedIn()) {
          await this.saveCookies();
          Logger.success("✅ Logged in + cookies saved");
          Logger.stopSpinner();
          return true;
        }
        throw new Error("Login verification failed");
      } catch (err) {
        Logger.warn(`Login attempt ${attempt} => ${err.message}`);
        if (attempt >= maxRetries) {
          Logger.stopSpinner(false);
          return false;
        }
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
      }
    }
    return false;
  }

  async randomDelay() {
    const min = this.config.twitter.minDelay;
    const max = this.config.twitter.maxDelay;
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    Logger.info(`Waiting ${ms}ms...`);
    return new Promise((r) => setTimeout(r, ms));
  }

  async collectMainTweets() {
    Logger.info(`Collecting up to ${this.config.twitter.maxTweets} tweets for @${this.username}`);
    let totalTweetsForUser = 0;
    try {
      const profile = await this.scraper.getProfile(this.username);
      totalTweetsForUser = profile.tweetsCount || 0;
      Logger.info(`Found approx. ${totalTweetsForUser} total tweets for @${this.username}`);
    } catch (err) {
      Logger.warn(`Profile => ${err.message}`);
    }
    const maxWanted = Math.min(this.config.twitter.maxTweets, totalTweetsForUser || 1e9);
    Logger.info(`searchTweets => "from:${this.username}", up to ${maxWanted}...`);
    const results = new Map();
    let count = 0;
    const iterator = this.scraper.searchTweets(`from:${this.username}`, maxWanted, SearchMode.Latest);
    for await (const raw of iterator) {
      if (!raw?.id) continue;
      if (!results.has(raw.id)) {
        results.set(raw.id, raw);
      }
      count++;
      if (count % 100 === 0) {
        Logger.info(`Fetched ${count} so far...`);
        await this.randomDelay();
      }
      if (count >= maxWanted) break;
    }
    Logger.success(`Got ${results.size} unique tweets from search`);
    return Array.from(results.values());
  }

  async fetchAllParentTweets(allTweets) {
    const replies = allTweets.filter((t) => t.inReplyToStatusId);
    Logger.info(`Need up to ${replies.length} parent tweets...`);
    if (!replies.length) return;
    let i = 0;
    for (const t of replies) {
      const parentId = t.inReplyToStatusId;
      if (!parentId) continue;
      try {
        const parent = await this.scraper.getTweet(parentId);
        t.inReplyToText = parent?.text || "";
      } catch (err) {
        Logger.warn(`fetch parent [${parentId}] => ${err.message}`);
        t.inReplyToText = "";
      }
      i++;
      if (i % 50 === 0) {
        Logger.info(`Fetched parent for ${i} replies so far...`);
        await this.randomDelay();
      }
    }
    Logger.info(`Done => parent fetch for ${replies.length} replies`);
  }

  async showSampleTweets(tweets) {
    const { showSample } = await inquirer.prompt([
      {
        type: "confirm",
        name: "showSample",
        message: "Show a sample of these tweets?",
        default: true,
      },
    ]);
    if (!showSample) return;
    const top = tweets.slice(0, 5);
    top.forEach((tw, i) => {
      console.log(chalk.cyan(`\n${i + 1}. [@${tw.username} ID=${tw.id}]`));
      console.log(chalk.white(tw.text || ""));
      if (tw.inReplyToText) {
        console.log(chalk.magenta(`Parent => ${tw.inReplyToText}`));
      }
    });
  }

  async run() {
    const startTime = Date.now();
    Logger.info("\n🐦 Pipeline => main w/ cookie login + agent parent fetch + fine-tune");
    try {
      await this.validateEnvironment();
      const ok = await this.initializeScraper();
      if (!ok) {
        Logger.error("Init failed => exit");
        return;
      }
      const mainTweets = await this.collectMainTweets();
      if (!mainTweets.length) {
        Logger.warn("No tweets => done");
        return;
      }
      Logger.info("Saving partial tweets...");
      await this.dataOrganizer.saveTweets(mainTweets);
      Logger.info("Fetching parent tweets...");
      await this.fetchAllParentTweets(mainTweets);
      Logger.info("Processing & saving final data...");
      await this.saveFineTuneData(mainTweets);
      const durSec = ((Date.now() - startTime) / 1000).toFixed(1);
      Logger.info(`Done => ${mainTweets.length} tweets in ${durSec}s`);
      await this.showSampleTweets(mainTweets);
      await this.cleanup();
    } catch (err) {
      Logger.error(`❌ Pipeline => ${err.message}`);
      await this.cleanup();
    }
  }

  async saveFineTuneData(allTweets) {
    await this.dataOrganizer.saveTweets(allTweets);
    const ftData = [];
    for (const t of allTweets) {
      if (
        t.username?.toLowerCase() === this.username.toLowerCase() &&
        t.inReplyToStatusId &&
        t.inReplyToText &&
        t.inReplyToText.trim() !== "" &&
        t.text &&
        t.text.trim() !== ""
      ) {
        ftData.push({
          prompt: t.inReplyToText.trim(),
          completion: t.text.trim(),
        });
      }
    }
    const baseDir = this.dataOrganizer.baseDir;
    const ftFile = path.join(baseDir, "processed", "finetuning.jsonl");
    await fs.mkdir(path.dirname(ftFile), { recursive: true });
    const lines = ftData.map((obj) => JSON.stringify(obj));
    await fs.writeFile(ftFile, lines.join("\n"), "utf-8");
    Logger.info(`Generated fine-tuning data => ${ftData.length} entries`);
    Logger.success(`Saved fine-tuning => ${ftFile}`);
  }

  async cleanup() {
    try {
      await this.scraper.logout();
      Logger.success("Logged out from agent");
    } catch (err) {
      Logger.warn(`Cleanup => ${err.message}`);
    }
    Logger.info("Cleanup done");
  }
}
