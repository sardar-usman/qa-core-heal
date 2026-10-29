# SauceDemo Selenium

A Mocha and Selenium example for the same login page as the Playwright demo. Credentials come from `SAUCE_USER` and `SAUCE_PASS`. They are not stored in this folder.

```sh
npm install selenium-webdriver mocha
SAUCE_USER=... SAUCE_PASS=... npx mocha test/login.test.js
```

Heal is not run by this README. A live SauceDemo heal needs those two variables in the environment.
