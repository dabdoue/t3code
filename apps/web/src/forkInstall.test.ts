import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";

import {
  resolveForkSshTarget,
  sshTargetFromCatalogEntry,
  sshTargetMatchesHint,
} from "./forkInstall.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env_lab");
const SSH_TARGET = {
  alias: "88",
  hostname: "132.239.222.55",
  username: "dabdoue",
  port: 22,
};

const sshEntry = {
  target: new SshConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "88",
    connectionId: "ssh:env_lab",
  }),
  profile: Option.some(
    new SshConnectionProfile({
      connectionId: "ssh:env_lab",
      environmentId: ENVIRONMENT_ID,
      label: "88",
      target: SSH_TARGET,
    }),
  ),
};

describe("fork SSH target resolution", () => {
  it("reads the SSH profile even when the live target is not tagged SSH", () => {
    const entry = {
      target: new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "88",
      }),
      profile: sshEntry.profile,
    };
    expect(sshTargetFromCatalogEntry(entry)).toEqual(SSH_TARGET);
  });

  it("matches an SSH host from another catalog entry using the server label", () => {
    const relayEntry = {
      target: new RelayConnectionTarget({
        environmentId: EnvironmentId.make("env_connect"),
        label: "88",
      }),
      profile: Option.none(),
    };
    expect(resolveForkSshTarget(relayEntry, [relayEntry, sshEntry], "88 server")).toEqual(
      SSH_TARGET,
    );
  });

  it("does not guess when multiple SSH hosts are connected and the label does not match", () => {
    const other = {
      target: new SshConnectionTarget({
        environmentId: EnvironmentId.make("env_other"),
        label: "other",
        connectionId: "ssh:env_other",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          connectionId: "ssh:env_other",
          environmentId: EnvironmentId.make("env_other"),
          label: "other",
          target: {
            alias: "other",
            hostname: "other.example.com",
            username: "dabdoue",
            port: 22,
          },
        }),
      ),
    };
    expect(resolveForkSshTarget(null, [sshEntry, other], "mystery server")).toBeNull();
  });

  it("ignores bearer connections without an SSH profile", () => {
    const bearer = {
      target: new BearerConnectionTarget({
        environmentId: EnvironmentId.make("env_url"),
        label: "url",
        connectionId: "bearer:env_url",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "bearer:env_url",
          environmentId: EnvironmentId.make("env_url"),
          label: "url",
          httpBaseUrl: "http://example.internal:3773/",
          wsBaseUrl: "ws://example.internal:3773/",
        }),
      ),
    };
    expect(sshTargetFromCatalogEntry(bearer)).toBeNull();
    expect(sshTargetMatchesHint(SSH_TARGET, "88 server")).toBe(true);
    expect(sshTargetMatchesHint(SSH_TARGET, "dabdoue@132.239.222.55")).toBe(true);
  });
});
