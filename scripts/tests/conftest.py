def pytest_configure(config):
    config.addinivalue_line(
        "markers", "network: live HTTP fetch — skip with -m 'not network' when rate-limited"
    )
