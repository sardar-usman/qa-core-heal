const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const user = process.env.SAUCE_USER;
const pass = process.env.SAUCE_PASS;

describe('saucedemo', () => {
  let driver;

  beforeEach(async () => {
    const options = new chrome.Options();
    if (process.env.QA_CORE_HEAL_CHROME) options.setChromeBinaryPath(process.env.QA_CORE_HEAL_CHROME);
    driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  });

  afterEach(async () => {
    if (driver) await driver.quit();
  });

  it('logs in', async () => {
    if (!user || !pass) throw new Error('SAUCE_USER and SAUCE_PASS are required');
    await driver.get('https://www.saucedemo.com/');
    await driver.findElement(By.css('[data-test="username"]')).sendKeys(user);
    await driver.findElement(By.css('[data-test="password"]')).sendKeys(pass);
    await driver.wait(until.elementLocated(By.id('login-button')), 5000);
    await driver.findElement(By.id('login-button')).click();
  });
});
