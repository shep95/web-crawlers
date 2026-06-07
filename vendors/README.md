# Vendor reference trees

Omnispider orchestrates patterns from these open-source crawler ecosystems. The full source trees are **not committed** to keep the repo lean — extract them locally from your Downloads or upstream:

| Archive | Upstream |
|---------|----------|
| `scrapy-master.zip` | [scrapy/scrapy](https://github.com/scrapy/scrapy) |
| `playwright-main.zip` | [microsoft/playwright](https://github.com/microsoft/playwright) |
| `puppeteer-main.zip` | [puppeteer/puppeteer](https://github.com/puppeteer/puppeteer) |
| `crawlee-master.zip` | [apify/crawlee](https://github.com/apify/crawlee) |
| `colly-master.zip` | [gocolly/colly](https://github.com/gocolly/colly) |
| `katana-dev.zip` | [projectdiscovery/katana](https://github.com/projectdiscovery/katana) |
| `splash-master.zip` | [scrapinghub/splash](https://github.com/scrapinghub/splash) |
| `MechanicalSoup-main.zip` | [MechanicalSoup/MechanicalSoup](https://github.com/MechanicalSoup/MechanicalSoup) |
| `portia-master.zip` | [scrapinghub/portia](https://github.com/scrapinghub/portia) |
| `heritrix3-master.zip` | [internetarchive/heritrix3](https://github.com/internetarchive/heritrix3) |
| `nutch-master.zip` | [apache/nutch](https://github.com/apache/nutch) |
| `stormcrawler-main.zip` | [DigitalPebble/storm-crawler](https://github.com/DigitalPebble/storm-crawler) |

```powershell
# Example: extract one vendor locally
Expand-Archive -Path scrapy-master.zip -DestinationPath vendors/scrapy-master
```

Run `omnispider engines` to see how each maps to an Omnispider engine adapter.
