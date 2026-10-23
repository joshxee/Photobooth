import { describe, expect, it } from "vitest";
import { ipRateKey } from "./rateKey";

describe("ipRateKey", () => {
  it("keys IPv4 by address and IPv6 by its /64, so rotating within one prefix doesn't help", () => {
    expect(ipRateKey("enrol", "198.51.100.7")).toBe("enrol:198.51.100.7");
    expect(ipRateKey("enrol", "2001:db8:1:2:aaaa::1")).toBe("enrol:2001:db8:1:2::/64");
    expect(ipRateKey("enrol", "2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("enrol:2001:db8:1:2::/64");
    expect(ipRateKey("enrol", "2001:db8::1")).toBe("enrol:2001:db8:0:0::/64");
    expect(ipRateKey("enrol", "::1")).toBe("enrol:0:0:0:0::/64");
    expect(ipRateKey("enrol", undefined)).toBe("enrol:unknown");
    expect(ipRateKey("session", "198.51.100.7")).toBe("session:198.51.100.7");
  });
});
