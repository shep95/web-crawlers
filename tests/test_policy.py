from omnispider.core.policy import normalize_url, domain_of, absolute_url

def test_normalize_url_strips_trailing_slash():
    assert normalize_url("https://Example.com/path/") == "https://example.com/path"


def test_domain_of():
    assert domain_of("https://www.example.com/page") == "www.example.com"


def test_absolute_url_skips_fragments():
    assert absolute_url("https://example.com", "#section") is None
    assert absolute_url("https://example.com", "/page") == "https://example.com/page"
