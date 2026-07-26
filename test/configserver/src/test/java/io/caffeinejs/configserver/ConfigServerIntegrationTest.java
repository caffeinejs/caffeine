package io.caffeinejs.configserver;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ConfigServerIntegrationTest {

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate rest;

    @Test
    void defaultProfileReturnsPropertySources() {
        ResponseEntity<Map> response = rest.getForEntity(
            "http://localhost:" + port + "/application/default",
            Map.class
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        List<?> propertySources = (List<?>) response.getBody().get("propertySources");
        assertThat(propertySources).isNotEmpty();
    }

    @Test
    void devProfileIncludesDevOverlay() {
        ResponseEntity<Map> response = rest.getForEntity(
            "http://localhost:" + port + "/caffeine/dev",
            Map.class
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        List<Map<String, Object>> propertySources = (List<Map<String, Object>>) response.getBody().get("propertySources");
        boolean hasDevEnvironment = propertySources.stream()
            .anyMatch(ps -> {
                Map<?, ?> source = (Map<?, ?>) ps.get("source");
                return source != null && "development".equals(source.get("caffeine.environment"));
            });

        assertThat(hasDevEnvironment).isTrue();
    }

    @Test
    void prodProfileIncludesProdOverlay() {
        ResponseEntity<Map> response = rest.getForEntity(
            "http://localhost:" + port + "/caffeine/prod",
            Map.class
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        List<Map<String, Object>> propertySources = (List<Map<String, Object>>) response.getBody().get("propertySources");
        boolean hasProdEnvironment = propertySources.stream()
            .anyMatch(ps -> {
                Map<?, ?> source = (Map<?, ?>) ps.get("source");
                return source != null && "production".equals(source.get("caffeine.environment"));
            });

        assertThat(hasProdEnvironment).isTrue();
    }

    @Test
    void caffeineAppPropertiesAreServed() {
        ResponseEntity<Map> response = rest.getForEntity(
            "http://localhost:" + port + "/caffeine/default",
            Map.class
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);

        List<Map<String, Object>> propertySources = (List<Map<String, Object>>) response.getBody().get("propertySources");
        boolean hasCaffeineApp = propertySources.stream()
            .anyMatch(ps -> {
                Map<?, ?> source = (Map<?, ?>) ps.get("source");
                return source != null && "caffeine-app".equals(source.get("caffeine.app"));
            });

        assertThat(hasCaffeineApp).isTrue();
    }
}
