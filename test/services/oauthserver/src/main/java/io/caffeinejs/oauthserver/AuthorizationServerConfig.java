package io.caffeinejs.oauthserver;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.core.oidc.OidcScopes;
import org.springframework.security.oauth2.core.oidc.OidcUserInfo;
import org.springframework.security.oauth2.core.oidc.endpoint.OidcParameterNames;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.authorization.oidc.authentication.OidcUserInfoAuthenticationContext;
import org.springframework.security.oauth2.server.authorization.oidc.authentication.OidcUserInfoAuthenticationToken;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.security.oauth2.server.authorization.client.InMemoryRegisteredClientRepository;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClient;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClientRepository;
import org.springframework.security.oauth2.server.authorization.config.annotation.web.configuration.OAuth2AuthorizationServerConfiguration;
import org.springframework.security.oauth2.server.authorization.config.annotation.web.configurers.OAuth2AuthorizationServerConfigurer;
import org.springframework.security.oauth2.server.authorization.settings.AuthorizationServerSettings;
import org.springframework.security.oauth2.server.authorization.OAuth2TokenType;
import org.springframework.security.oauth2.server.authorization.settings.ClientSettings;
import org.springframework.security.oauth2.server.authorization.settings.TokenSettings;
import org.springframework.security.oauth2.server.authorization.token.JwtEncodingContext;
import org.springframework.security.oauth2.server.authorization.token.OAuth2TokenCustomizer;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.LoginUrlAuthenticationEntryPoint;
import org.springframework.security.web.util.matcher.MediaTypeRequestMatcher;

/**
 * Authorization server for the @caffeinejs/http authentication e2e tests.
 *
 * Two confidential authorization-code clients with PKCE and no consent screen, for the OIDC and the
 * plain OAuth 2.0 sign-in. Two in-memory users who differ in their roles, so authorization has
 * something to refuse. Three client_credentials clients, for caffeine acting as a resource server:
 * the API's own, one whose tokens expire in seconds, and one whose tokens are minted for another
 * audience.
 */
@Configuration
@EnableWebSecurity
public class AuthorizationServerConfig {

    private static final String ISSUER = "http://localhost:9000";

    /** What the server knows about a user beyond the password. */
    private record Profile(String email, String name, List<String> roles) {}

    private static final Map<String, Profile> PROFILES = Map.of(
            "alice", new Profile("alice@example.com", "Alice Liddell", List.of("admin", "user")),
            "bob", new Profile("bob@example.com", "Bob Builder", List.of("user")));

    /** Roles stamped on a client_credentials access token, where the subject is the client itself. */
    private static final List<String> SERVICE_ROLES = List.of("service");

    /**
     * Builds the /userinfo response, including the non-standard `roles` claim.
     *
     * The same list the id_token carries. caffeine's plain OAuth 2.0 strategy maps user info through an
     * allowlist and refuses to rename a field into the role claim, so its e2e reads this with a claimMapper.
     */
    private static final Function<OidcUserInfoAuthenticationContext, OidcUserInfo> USER_INFO_MAPPER = context -> {
        OidcUserInfoAuthenticationToken authentication = context.getAuthentication();
        JwtAuthenticationToken principal = (JwtAuthenticationToken) authentication.getPrincipal();
        String subject = principal.getToken().getSubject();
        Profile profile = PROFILES.get(subject);
        return OidcUserInfo.builder()
                .subject(subject)
                .email(profile.email())
                .name(profile.name())
                .claim("roles", profile.roles())
                .build();
    };

    @Bean
    @Order(1)
    public SecurityFilterChain authorizationServerSecurityFilterChain(HttpSecurity http) throws Exception {
        OAuth2AuthorizationServerConfiguration.applyDefaultSecurity(http);
        http.getConfigurer(OAuth2AuthorizationServerConfigurer.class)
                // Custom userinfo mapper so /userinfo also returns the non-standard `roles` claim
                // (the default mapper only emits standard, scope-derived claims like email/name),
                // which the caffeine OAuth2 flow relies on for role authorization.
                .oidc(oidc -> oidc.userInfoEndpoint(userInfo -> userInfo.userInfoMapper(USER_INFO_MAPPER)));
        http
                // Redirect unauthenticated browser requests to the login page.
                .exceptionHandling(exceptions -> exceptions
                        .defaultAuthenticationEntryPointFor(
                                new LoginUrlAuthenticationEntryPoint("/login"),
                                new MediaTypeRequestMatcher(MediaType.TEXT_HTML)))
                // Accept the access token as a bearer credential on the userinfo endpoint.
                .oauth2ResourceServer(resourceServer -> resourceServer.jwt(Customizer.withDefaults()));
        return http.build();
    }

    @Bean
    @Order(2)
    public SecurityFilterChain defaultSecurityFilterChain(HttpSecurity http) throws Exception {
        http
                .authorizeHttpRequests(authorize -> authorize
                        .requestMatchers("/actuator/health").permitAll()
                        .anyRequest().authenticated())
                .formLogin(Customizer.withDefaults());
        return http.build();
    }

    @Bean
    public UserDetailsService userDetailsService() {
        UserDetails alice = User.withUsername("alice")
                .password("{noop}wonderland")
                .roles("USER")
                .build();
        UserDetails bob = User.withUsername("bob")
                .password("{noop}builder")
                .roles("USER")
                .build();
        return new InMemoryUserDetailsManager(alice, bob);
    }

    @Bean
    public RegisteredClientRepository registeredClientRepository() {
        ClientSettings clientSettings = ClientSettings.builder()
                .requireAuthorizationConsent(false)
                .requireProofKey(true)
                .build();

        RegisteredClient oidcClient = RegisteredClient.withId(UUID.randomUUID().toString())
                .clientId("caffeine-oidc")
                .clientSecret("{noop}caffeine-oidc-secret")
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_POST)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
                .redirectUri("http://localhost:9999/oidc/callback")
                // RP-initiated logout returns here; an unregistered value is refused.
                .postLogoutRedirectUri("http://localhost:9999/signed-out")
                .scope(OidcScopes.OPENID)
                .scope(OidcScopes.PROFILE)
                .scope(OidcScopes.EMAIL)
                .clientSettings(clientSettings)
                .build();

        RegisteredClient oauth2Client = RegisteredClient.withId(UUID.randomUUID().toString())
                .clientId("caffeine-oauth2")
                .clientSecret("{noop}caffeine-oauth2-secret")
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_POST)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
                .redirectUri("http://localhost:9999/oauth2/callback")
                .scope(OidcScopes.OPENID)
                .scope(OidcScopes.PROFILE)
                .scope(OidcScopes.EMAIL)
                .clientSettings(clientSettings)
                .build();

        RegisteredClient apiClient = serviceClient("caffeine-api", Duration.ofMinutes(5));
        // Short enough for a spec to outlive the token it was just given.
        RegisteredClient shortLivedClient = serviceClient("caffeine-api-short", Duration.ofSeconds(2));
        // Its tokens carry its own id as the audience, which is not the API's.
        RegisteredClient otherClient = serviceClient("caffeine-other", Duration.ofMinutes(5));

        return new InMemoryRegisteredClientRepository(
                oidcClient, oauth2Client, apiClient, shortLivedClient, otherClient);
    }

    /** A client that signs in as itself, `<clientId>-secret` being its secret. */
    private static RegisteredClient serviceClient(String clientId, Duration accessTokenTimeToLive) {
        return RegisteredClient.withId(UUID.randomUUID().toString())
                .clientId(clientId)
                .clientSecret("{noop}" + clientId + "-secret")
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)
                .scope("api.read")
                .tokenSettings(TokenSettings.builder().accessTokenTimeToLive(accessTokenTimeToLive).build())
                .build();
    }

    /**
     * Adds email + name + roles to the id_token of the user who signed in, and roles to the access token
     * of a client that signed in as itself.
     */
    @Bean
    public OAuth2TokenCustomizer<JwtEncodingContext> tokenCustomizer() {
        return context -> {
            if (OidcParameterNames.ID_TOKEN.equals(context.getTokenType().getValue())) {
                Profile profile = PROFILES.get(context.getPrincipal().getName());
                context.getClaims().claim("email", profile.email());
                context.getClaims().claim("name", profile.name());
                context.getClaims().claim("roles", profile.roles());
            } else if (OAuth2TokenType.ACCESS_TOKEN.equals(context.getTokenType())
                    && AuthorizationGrantType.CLIENT_CREDENTIALS.equals(context.getAuthorizationGrantType())) {
                context.getClaims().claim("roles", SERVICE_ROLES);
            }
        };
    }

    @Bean
    public JWKSource<SecurityContext> jwkSource() {
        KeyPair keyPair = generateRsaKey();
        RSAPublicKey publicKey = (RSAPublicKey) keyPair.getPublic();
        RSAPrivateKey privateKey = (RSAPrivateKey) keyPair.getPrivate();
        RSAKey rsaKey = new RSAKey.Builder(publicKey)
                .privateKey(privateKey)
                .keyID(UUID.randomUUID().toString())
                .build();
        return new ImmutableJWKSet<>(new JWKSet(rsaKey));
    }

    @Bean
    public JwtDecoder jwtDecoder(JWKSource<SecurityContext> jwkSource) {
        return OAuth2AuthorizationServerConfiguration.jwtDecoder(jwkSource);
    }

    @Bean
    public AuthorizationServerSettings authorizationServerSettings() {
        return AuthorizationServerSettings.builder()
                .issuer(ISSUER)
                .build();
    }

    private static KeyPair generateRsaKey() {
        try {
            KeyPairGenerator keyPairGenerator = KeyPairGenerator.getInstance("RSA");
            keyPairGenerator.initialize(2048);
            return keyPairGenerator.generateKeyPair();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
