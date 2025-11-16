---
description: TDD Red Phase - Write a failing test
---

# TDD Red Phase 🔴

In the **Red** phase of Test-Driven Development, you write a failing test BEFORE implementing the feature.

## Instructions

I will help you:

1. **Understand the requirement** - What feature are you implementing?
2. **Write a test in commonTest** - Start with common code that works on all platforms
3. **Run the test** - Verify it fails (as expected, since the code doesn't exist yet)
4. **Confirm the failure** - Make sure it fails for the RIGHT reason (missing implementation, not syntax error)

## Best Practices

- Write tests in `composeApp/src/commonTest/kotlin/` for cross-platform features
- Use descriptive test names: `fun shouldCalculateTotalWhenItemsAdded()`
- Test ONE thing per test function
- Use kotlin.test annotations: `@Test`, `@BeforeTest`, `@AfterTest`
- Use assertions: `assertEquals()`, `assertTrue()`, `assertFailsWith()`

## After Running This Command

Once we have a failing test, use `/tdd-green` to implement the minimal code to make it pass.

---

**Ready to write your first failing test?** Tell me what feature you want to implement!
