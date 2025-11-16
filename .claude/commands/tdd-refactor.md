---
description: TDD Refactor Phase - Improve code quality
---

# TDD Refactor Phase 🔵

In the **Refactor** phase of Test-Driven Development, you improve code quality while keeping all tests green.

## Instructions

I will help you:

1. **Verify tests are passing** - Ensure we have a green baseline
2. **Identify code smells** - Look for duplication, poor naming, complexity
3. **Refactor incrementally** - Make small improvements one at a time
4. **Run tests after each change** - Ensure tests stay green throughout
5. **Confirm final state** - All tests still pass, code is cleaner

## Common Refactoring Patterns

- **Extract function** - Pull out duplicated code
- **Rename** - Improve variable/function names for clarity
- **Simplify conditionals** - Reduce complexity
- **Remove dead code** - Delete unused code
- **Extract constants** - Replace magic numbers/strings
- **Improve structure** - Better organize files and packages

## Run Tests Continuously

```bash
# Auto-run tests on every file change
./gradlew allTests --continuous
```

This gives you immediate feedback if a refactoring breaks something!

## Best Practices

- Make ONE refactoring at a time
- Run tests after EACH change
- If tests fail, revert and try a different approach
- Stop when the code is clean - don't over-engineer
- Refactor tests too - they're code that needs maintenance

## After Running This Command

After refactoring, return to `/tdd-red` to start the next feature!

---

**Ready to clean up the code?** I'll help you refactor while keeping all tests green.
